import { readFile, readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from 'cheerio';

// Приводим обычные и неразрывные пробелы HTML к одному читаемому виду.
function normalizeText(value) {
  return value.replace(/\s+/gu, ' ').trim();
}

// Собираем текст карточки с разделителями между узлами, без скриптов и стилей.
function cardText(node) {
  if (node.type === 'text') return node.data;
  if (['script', 'style'].includes(node.name)) return '';
  return (node.children ?? []).map(cardText).join(' ');
}

// Возвращаем уникальные непустые подписи метро и условий работы.
function texts($, elements) {
  return [...new Set(elements.toArray().map((node) => normalizeText($(node).text())).filter(Boolean))];
}

// Извлекаем общий для выдачи и полных вакансий комментарий SingleFile.
function singleFileMetadata(html) {
  const metadata = html.match(/<!--\s*Page saved with SingleFile\b([\s\S]*?)-->/)?.[1] ?? '';
  return {
    url: metadata.match(/^\s*url:\s*(\S+)/m)?.[1] ?? null,
    saved_date: metadata.match(/^\s*saved date:\s*(.+)/m)?.[1].trim() ?? null,
  };
}

// Сохраняем абзацы и пункты описания, не склеивая строки и не разрывая inline-текст.
function descriptionText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.data;
  if (['script', 'style', 'noscript'].includes(node.name)) return '';
  if (node.name === 'br') return '\n';
  const content = (node.children ?? []).map(descriptionText).join('');
  if (node.name === 'li') return `\n- ${content.trim()}\n`;
  if (['p', 'div', 'section', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'blockquote'].includes(node.name)) {
    return `\n${content}\n`;
  }
  return content;
}

// JobPosting нужен только для даты и города; видимые условия и описание берём из DOM.
function jobMetadata($, file, warnings) {
  for (const node of $('script[type="application/ld+json"]').toArray()) {
    try {
      const data = JSON.parse($(node).text());
      const job = (Array.isArray(data) ? data : [data]).find((item) => item?.['@type'] === 'JobPosting');
      if (job) return job;
    } catch {
      warnings.push(`${file}: не удалось прочитать JSON-LD; доступные поля извлечены из HTML.`);
    }
  }
  return {};
}

// Проверяем адрес вакансии на доменах группы HH, включая региональные поддомены.
function vacancyId(href) {
  if (!href) return null;
  try {
    const url = new URL(href, 'https://hh.ru');
    return /^https?:$/.test(url.protocol) && /(^|\.)(hh\.(ru|kz|uz)|hh1\.az|rabota\.by|headhunter\.(ge|kg))$/i.test(url.hostname)
      ? url.pathname.match(/^\/vacancy\/(\d+)\/?$/)?.[1] ?? null
      : null;
  } catch {
    return null;
  }
}

// Форматируем явно заданную зарплату InitialState без догадок о налогах или периоде.
function initialStateSalary(compensation, state) {
  if (!compensation || compensation.noCompensation) return null;
  const from = compensation.perModeFrom ?? compensation.from;
  const to = compensation.perModeTo ?? compensation.to;
  if (from == null && to == null) return null;
  const number = new Intl.NumberFormat('ru-RU');
  const currency = state.currencies?.list?.find((item) => item.code === compensation.currencyCode)?.name
    ?? (compensation.currencyCode === 'RUR' ? '₽' : compensation.currencyCode);
  const mode = state.vacancyFieldsDictionary?.mode?.find((item) => item.id === compensation.mode)?.text;
  return [from != null ? `от ${number.format(from)}` : null,
    to != null ? `до ${number.format(to)}` : null, currency,
    mode?.toLocaleLowerCase('ru-RU'),
    compensation.gross === true ? 'до вычета налогов' : compensation.gross === false ? 'на руки' : null,
  ].filter(Boolean).join(' ');
}

// В HTML без готового DOM читаем полную вакансию из встроенного JSON, без запуска JavaScript.
function restoreInitialState($, file, expectedId) {
  const template = $('#HH-Lux-InitialState').first();
  if (!template.length) return false;
  let state;
  try { state = JSON.parse(template.text()); }
  catch { throw new Error(`${file}: повреждён JSON InitialState.`); }
  const vacancy = state.vacancyView?.vacancyFull?.vacancy;
  if (!vacancy?.name || !vacancy.description) return false;
  if (String(vacancy.vacancyId) !== expectedId) {
    throw new Error(`${file}: ID вакансии в InitialState и адресе страницы различаются.`);
  }
  const dictionary = state.vacancyFieldsDictionary ?? {};
  // Используем подписи из того же HTML, а неизвестные перечисления оставляем как есть.
  const labels = (name, values) => (Array.isArray(values) ? values : values ? [values] : [])
    .map((value) => dictionary[name]?.find((item) => item.id === value)?.text ?? value).join(', ');
  const container = $('<section>');
  // Создаём промежуточные узлы только в памяти, чтобы сохранить общий путь разбора полей.
  const field = (qa, value) => {
    if (!value) return;
    container.append($('<div>').attr('data-qa', qa).text(value));
  };
  field('vacancy-title', vacancy.name);
  container.append($('<div>').attr('data-qa', 'vacancy-description').html(vacancy.description));
  const company = $('<a>').attr('data-qa', 'vacancy-company-name').text(vacancy.company?.name ?? '');
  if (vacancy.company?.id) company.attr('href', `/employer/${vacancy.company.id}`);
  container.append(company);
  field('vacancy-salary', initialStateSalary(vacancy.compensation, state));
  field('vacancy-experience', state.vacancyView?.translations?.workExperience);
  field('vacancy-view-raw-address', vacancy.address?.displayName ?? vacancy.address?.city);
  field('common-employment-text', labels('employmentForm', vacancy.employmentForm));
  const contracts = [vacancy.acceptLaborContract ? 'Трудовой договор' : null,
    labels('civilLawContract', vacancy.civilLawContracts)].filter(Boolean).join(', ');
  field('vacancy-hiring-formats', contracts);
  const schedule = labels('workScheduleByDays', vacancy.workScheduleByDays);
  const hours = labels('workingHours', vacancy.workingHours);
  const formats = labels('workFormats', vacancy.workFormats);
  field('work-schedule-by-days-text', schedule ? `График: ${schedule}` : null);
  field('working-hours-text', hours ? `Рабочие часы: ${hours}` : null);
  field('work-formats-text', formats ? `Формат работы: ${formats}` : null);
  for (const skill of vacancy.keySkills ?? []) field('skills-element', skill);
  if (state.applicationLdJSON) {
    container.append($('<script>').attr('type', 'application/ld+json').text(state.applicationLdJSON));
  }
  $.root().append(container);
  return true;
}

// Разбираем одну полную вакансию; рекомендации и личные элементы страницы не включаем.
export function parseVacancyPage(html, file, $ = load(html)) {
  const metadata = singleFileMetadata(html);
  const canonical = $('link[rel="canonical"]').attr('href');
  const canonicalId = vacancyId(canonical);
  const savedId = vacancyId(metadata.url);
  const id = canonicalId ?? savedId;
  const hasVisibleFields = $('[data-qa="vacancy-title"]').first().text().trim()
    && $('[data-qa="vacancy-description"]').first().text().trim();
  const restored = !hasVisibleFields && id ? restoreInitialState($, file, id) : false;
  const title = normalizeText($('[data-qa="vacancy-title"]').first().text());
  const description = descriptionText($('[data-qa="vacancy-description"]').first()[0])
    .replace(/[\u200B\uFEFF]/gu, '').split('\n').map(normalizeText).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  if (!id || !title || !description) {
    throw new Error(`${file}: у полной вакансии нет ID, названия или описания; проверьте сохранённую страницу.`);
  }
  if (canonicalId && savedId && canonicalId !== savedId) {
    throw new Error(`${file}: ID вакансии в canonical и SingleFile различаются.`);
  }

  // Не подменяем отсутствующую зарплату нулём; условия оставляем формулировками HH.
  const warnings = [];
  const job = jobMetadata($, file, warnings);
  const field = (qa) => normalizeText($(`[data-qa="${qa}"]`).first().text()) || null;
  const employer = $('[data-qa="vacancy-company-name"]').first();
  const employerHref = employer.attr('href');
  const salaryNode = $('[data-qa="vacancy-salary"]').first();
  const salaryText = normalizeText(salaryNode.length
    ? salaryNode.text() : $('.vacancy-title').first().children('span').first().text());
  const salary = !salaryText || /уровень дохода не указан/i.test(salaryText) ? null : salaryText;
  const address = field('vacancy-view-raw-address') ?? field('vacancy-address-with-map');
  const workFormat = field('work-formats-text');
  const vacancy = {
    id,
    url: `https://hh.ru/vacancy/${id}`,
    title,
    employer: normalizeText(employer.text()) || null,
    employer_url: employerHref ? new URL(employerHref, metadata.url ?? canonical ?? 'https://hh.ru').href : null,
    salary,
    experience: field('vacancy-experience'),
    location: job.jobLocation?.address?.addressLocality ?? null,
    address,
    employment: field('common-employment-text'),
    hiring_format: field('vacancy-hiring-formats'),
    schedule: field('work-schedule-by-days-text'),
    working_hours: field('working-hours-text'),
    work_format: workFormat,
    skills: texts($, $('[data-qa="skills-element"]')),
    description,
    published_at: job.datePosted ?? null,
    valid_through: job.validThrough ?? null,
    sources: [{ file, position: 1 }],
  };
  return {
    source: { file, ...metadata, url: metadata.url ?? canonical ?? null,
      ...(restored ? { data_source: 'initial_state' } : {}),
      page_type: 'vacancy', heading: title, card_count: 1 },
    vacancies: [vacancy],
    warnings,
  };
}

// Разбираем сохранённую выдачу: HTML обрабатывается локально и не исполняется.
export function parseSearchPage(html, file, $ = load(html)) {
  const cards = $('[data-qa="vacancy-serp__vacancy"]');
  if (!cards.length) {
    throw new Error(`${file}: карточки выдачи HH не найдены; проверьте сохранённую страницу.`);
  }

  // Метаданные SingleFile сохраняют адрес поиска и время создания копии.
  const metadata = singleFileMetadata(html);
  const sourceUrl = metadata.url;
  const url = sourceUrl ? new URL(sourceUrl) : null;
  const heading = normalizeText($('h1').first().text());
  const totalMatch = heading.match(/Найден[а-яё]*\s+([\d\s]+)\s+ваканс/iu);
  const source = {
    file,
    url: sourceUrl,
    saved_date: metadata.saved_date,
    heading,
    query: url?.searchParams.get('text') ?? null,
    page: url ? Number(url.searchParams.get('page') ?? 0) + 1 : null,
    page_size: url?.searchParams.has('items_on_page') ? Number(url.searchParams.get('items_on_page')) : null,
    reported_total: totalMatch ? Number(totalMatch[1].replace(/\s/g, '')) : null,
    card_count: cards.length,
  };

  // Обязательные название и ID проверяем у каждой карточки, чтобы не терять её молча.
  const vacancies = cards.toArray().map((node, index) => {
    const card = $(node);
    const titleLink = card.find('[data-qa="serp-item__title"]').first();
    const title = normalizeText(titleLink.text());
    const href = titleLink.attr('href');
    const vacancyUrl = href ? new URL(href, sourceUrl ?? 'https://hh.ru') : null;
    const id = vacancyUrl?.pathname.match(/^\/vacancy\/(\d+)\/?$/)?.[1];
    if (!id || !title || !/(^|\.)hh\.ru$/i.test(vacancyUrl.hostname)) {
      throw new Error(`${file}: у карточки ${index + 1} нет названия или корректной ссылки на вакансию HH.`);
    }

    const employer = card.find('[data-qa="vacancy-serp__vacancy-employer"]').first();
    const employerHref = employer.attr('href');
    // Анонимный работодатель имеет подпись, но не ссылку на публичный профиль.
    const employerName = card.find('[data-qa="vacancy-serp__vacancy-employer-text"]').first();
    // У зарплаты в этой разметке нет data-qa; берём прямую подпись блока компенсации.
    const salary = card.find('[class*="compensation-labels--"] > span').first();
    return {
      id,
      url: `https://hh.ru/vacancy/${id}`,
      title,
      employer: normalizeText(employerName.length ? employerName.text() : employer.text()) || null,
      employer_url: employerHref ? new URL(employerHref, sourceUrl ?? 'https://hh.ru').href : null,
      salary: normalizeText(salary.text()) || null,
      experience: normalizeText(card.find('[data-qa^="vacancy-serp__vacancy-work-experience-"]').first().text()) || null,
      location: normalizeText(card.find('[data-qa="vacancy-serp__vacancy-address"]').first().text()) || null,
      metro: texts($, card.find('[data-qa="address-metro-station-name"]')),
      labels: texts($, card.find('[data-qa^="vacancy-label-"], [data-qa^="vacancy-serp__vacancy-compensation-frequency-"]')),
      card_text: normalizeText(cardText(node)),
      sources: [{ file, position: index + 1 }],
    };
  });

  // Сверяем размер страницы с её номером и общим счётчиком сохранённой выдачи.
  const warnings = [];
  if (source.page && source.page_size && source.reported_total !== null) {
    const expected = Math.max(0, Math.min(source.page_size, source.reported_total - (source.page - 1) * source.page_size));
    if (cards.length !== expected) {
      warnings.push(`${file}: ожидалось ${expected} карточек, найдено ${cards.length}.`);
    }
  }
  return { source, vacancies, warnings };
}

// Объединяем страницы по ID, сохраняя каждое вхождение и исходные значения при дублях.
export function mergePages(pages) {
  const byId = new Map();
  const warnings = pages.flatMap((page) => page.warnings);
  for (const page of pages) {
    for (const vacancy of page.vacancies) {
      const previous = byId.get(vacancy.id);
      if (previous) {
        previous.sources.push(...vacancy.sources);
        const { sources: previousSources, ...previousFields } = previous;
        const { sources: currentSources, ...currentFields } = vacancy;
        if (JSON.stringify(previousFields) !== JSON.stringify(currentFields)) {
          warnings.push(`Вакансия ${vacancy.id} различается между копиями; сохранены поля первого вхождения.`);
        }
      } else {
        byId.set(vacancy.id, { ...vacancy, sources: [...vacancy.sources] });
      }
    }
  }

  const sources = pages.map((page) => page.source);
  const cardCount = sources.reduce((sum, source) => sum + source.card_count, 0);
  return {
    sources,
    summary: {
      file_count: pages.length,
      card_count: cardCount,
      unique_count: byId.size,
      duplicate_count: cardCount - byId.size,
    },
    warnings,
    vacancies: [...byId.values()],
  };
}

// Читаем файлы последовательно, чтобы большие копии SingleFile не занимали память одновременно.
export async function parseFiles(files) {
  const pages = [];
  for (const file of files) {
    const html = await readFile(file, 'utf8');
    const $ = load(html);
    // Адрес помогает распознать даже неполную вакансию и не принять рекомендации за выдачу.
    const isVacancy = $('[data-qa="vacancy-title"]').length
      || vacancyId($('link[rel="canonical"]').attr('href'))
      || vacancyId(singleFileMetadata(html).url);
    const page = isVacancy
      ? parseVacancyPage(html, file, $)
      : parseSearchPage(html, file, $);
    // Отделяем короткие строки результата от больших строк HTML, которые V8 может удерживать через подстроки.
    pages.push(JSON.parse(JSON.stringify(page)));
  }
  return mergePages(pages);
}

// CLI принимает один HTML или каталог страниц и явный путь к итоговому JSON.
async function main(args) {
  if (args.length !== 2) {
    throw new Error('Использование: npm run parse:hh -- <HTML или каталог> <выходной JSON>');
  }
  const [input, output] = args;
  const files = (await stat(input)).isDirectory()
    ? (await readdir(input)).filter((name) => /\.html?$/i.test(name)).sort().map((name) => path.join(input, name))
    : [input];
  if (!files.length) throw new Error(`${input}: HTML-файлы не найдены.`);
  if (files.some((file) => path.resolve(file) === path.resolve(output))) {
    throw new Error('Выходной файл не должен заменять исходный HTML.');
  }

  // Записываем результат только после успешного разбора всех исходников.
  const result = await parseFiles(files);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Файлов: ${result.summary.file_count}; карточек: ${result.summary.card_count}; уникальных: ${result.summary.unique_count}; дублей: ${result.summary.duplicate_count}.`);
  for (const warning of result.warnings) console.warn(`Предупреждение: ${warning}`);
  console.log(`Результат: ${output}`);
}

// При импорте тестами CLI не запускается; ошибки команды возвращают ненулевой код.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

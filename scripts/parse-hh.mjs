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

// Разбираем сохранённую выдачу: HTML обрабатывается локально и не исполняется.
export function parseSearchPage(html, file) {
  const $ = load(html);
  const cards = $('[data-qa="vacancy-serp__vacancy"]');
  if (!cards.length) {
    throw new Error(`${file}: карточки выдачи HH не найдены; проверьте сохранённую страницу.`);
  }

  // Метаданные SingleFile сохраняют адрес поиска и время создания копии.
  const metadata = html.match(/<!--\s*Page saved with SingleFile\b([\s\S]*?)-->/)?.[1] ?? '';
  const sourceUrl = metadata.match(/^\s*url:\s*(\S+)/m)?.[1] ?? null;
  const url = sourceUrl ? new URL(sourceUrl) : null;
  const heading = normalizeText($('h1').first().text());
  const totalMatch = heading.match(/Найден[а-яё]*\s+([\d\s]+)\s+ваканс/iu);
  const source = {
    file,
    url: sourceUrl,
    saved_date: metadata.match(/^\s*saved date:\s*(.+)/m)?.[1].trim() ?? null,
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
    pages.push(parseSearchPage(await readFile(file, 'utf8'), file));
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

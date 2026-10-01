import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseFiles, parseVacancyPage } from '../scripts/parse-hh.mjs';

// Вымышленная страница воспроизводит видимые поля и служебные данные полной вакансии.
function vacancyPage({ fields = true, metadata = true, description = true } = {}) {
  return `<!doctype html><html><head>
    <!-- Page saved with SingleFile
    url: https://hh.ru/vacancy/501?from=search
    saved date: Tue Jan 01 2030 12:00:00 GMT+0300
    -->
    <link rel="canonical" href="https://spb.hh.ru/vacancy/501">
    ${metadata ? `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting', datePosted: '2030-01-01T12:00:00+03:00',
      validThrough: '2030-02-01T12:00:00+03:00',
      jobLocation: { address: { addressLocality: 'Тестовый город' } },
      description: 'Служебная копия не должна заменять видимое описание.',
    })}</script>` : ''}
    </head><body>
    <div class="vacancy-title"><h1 data-qa="vacancy-title">SRE &amp; Observability</h1>
      ${fields
        ? '<div data-qa="vacancy-salary"><span>от <data value="320000">320&#8239;000</data> ₽ за месяц, <span>на руки</span></span></div>'
        : '<span>Уровень дохода не указан</span>'}</div>
    ${fields ? `<a data-qa="vacancy-company-name" href="/employer/42">ООО&nbsp;Пример</a>
      <span data-qa="vacancy-experience">3–6 лет</span>
      <div data-qa="common-employment-text">Полная занятость</div>
      <p data-qa="vacancy-hiring-formats">Оформление: Трудовой договор</p>
      <p data-qa="work-schedule-by-days-text">График: 5/2</p>
      <div data-qa="working-hours-text">Рабочие часы: 8</div>
      <p data-qa="work-formats-text">Формат работы: удалённо или гибрид</p>
      <div data-qa="vacancy-view-raw-address">Тестовый город, Учебная улица, 1</div>
      <span data-qa="skills-element">PromQL</span><span data-qa="skills-element">C#</span>
      <span data-qa="skills-element">PromQL</span>` : ''}
    ${description ? `<div data-qa="vacancy-description"><p><strong>Задачи:</strong></p>
      <ul><li><p>Метрики &amp; алерты.</p></li><li>Автоматизация на C<strong>#</strong>.</li></ul>
      <p>Первая строка.<br>Вторая строка.</p>
      <p>Опыт работы с Elastic<strong>search</strong>.</p>
      <script>ЛИЧНЫЕ ДАННЫЕ</script><style>СЛУЖЕБНЫЙ СТИЛЬ</style></div>` : ''}
    <div data-qa="vacancy-company">Рекламный баннер работодателя</div>
    <div data-qa="vacancy-serp__vacancy"><a data-qa="serp-item__title" href="/vacancy/999">Рекомендация</a></div>
    </body></html>`;
}

// Проверяем реальные различия полной страницы: абзацы, ссылки, условия и метаданные.
test('извлекает полное описание и условия без рекомендаций и служебных данных', () => {
  const page = parseVacancyPage(vacancyPage(), 'detail.html');
  const vacancy = page.vacancies[0];
  assert.equal(vacancy.id, '501');
  assert.equal(vacancy.url, 'https://hh.ru/vacancy/501');
  assert.equal(vacancy.title, 'SRE & Observability');
  assert.equal(vacancy.employer, 'ООО Пример');
  assert.equal(vacancy.employer_url, 'https://hh.ru/employer/42');
  assert.equal(vacancy.salary, 'от 320 000 ₽ за месяц, на руки');
  assert.equal(vacancy.experience, '3–6 лет');
  assert.equal(vacancy.location, 'Тестовый город');
  assert.equal(vacancy.address, 'Тестовый город, Учебная улица, 1');
  assert.equal(vacancy.employment, 'Полная занятость');
  assert.equal(vacancy.hiring_format, 'Оформление: Трудовой договор');
  assert.equal(vacancy.schedule, 'График: 5/2');
  assert.equal(vacancy.working_hours, 'Рабочие часы: 8');
  assert.equal(vacancy.work_format, 'Формат работы: удалённо или гибрид');
  assert.deepEqual(vacancy.skills, ['PromQL', 'C#']);
  assert.equal(vacancy.published_at, '2030-01-01T12:00:00+03:00');
  assert.equal(vacancy.valid_through, '2030-02-01T12:00:00+03:00');
  assert.match(vacancy.description, /- Метрики & алерты\./);
  assert.match(vacancy.description, /- Автоматизация на C#\./);
  assert.match(vacancy.description, /Первая строка\.\nВторая строка\./);
  assert.match(vacancy.description, /Elasticsearch/);
  assert.doesNotMatch(vacancy.description, /ЛИЧНЫЕ|СЛУЖЕБНЫЙ|Служебная копия|Рекомендация|Рекламный баннер/);
  assert.equal(page.source.saved_date, 'Tue Jan 01 2030 12:00:00 GMT+0300');
  assert.equal(page.source.page_type, 'vacancy');
  assert.deepEqual(vacancy.sources, [{ file: 'detail.html', position: 1 }]);
  assert.deepEqual(page.warnings, []);
});

// Неуказанные условия не должны превращаться в подтверждённую удалёнку или доход.
test('сохраняет null для отсутствующих условий и неуказанной зарплаты', () => {
  const vacancy = parseVacancyPage(vacancyPage({ fields: false, metadata: false }), 'minimal.html').vacancies[0];
  for (const name of ['salary', 'experience', 'location', 'address', 'employer', 'employer_url',
    'employment', 'hiring_format', 'schedule', 'working_hours', 'work_format', 'published_at', 'valid_through']) {
    assert.equal(vacancy[name], null, name);
  }
  assert.deepEqual(vacancy.skills, []);
  assert.ok(vacancy.description);
});

// Диапазон и налоговую оговорку сохраняем целиком из отдельного блока зарплаты.
test('сохраняет обе границы зарплаты и условие до вычета налогов', () => {
  const html = vacancyPage().replace(/<div data-qa="vacancy-salary">.*?<\/div>/,
    '<div data-qa="vacancy-salary"><span>от <data>300&nbsp;000</data> до <data>400&nbsp;000</data> ₽ за месяц, <span>до вычета налогов</span></span></div>');
  const vacancy = parseVacancyPage(html, 'salary.html').vacancies[0];
  assert.equal(vacancy.salary, 'от 300 000 до 400 000 ₽ за месяц, до вычета налогов');
});

// Отсутствие необязательных SEO-данных не должно мешать чтению самого объявления.
test('предупреждает о повреждённом JSON-LD и сохраняет описание', () => {
  const html = vacancyPage().replace(/<script type="application\/ld\+json">.*?<\/script>/,
    '<script type="application/ld+json">{broken}</script>');
  const page = parseVacancyPage(html, 'broken-metadata.html');
  assert.equal(page.vacancies[0].published_at, null);
  assert.match(page.vacancies[0].description, /Метрики/);
  assert.match(page.warnings[0], /JSON-LD/);
});

// Не принимаем неполную копию, CAPTCHA или страницу с конфликтующими адресами.
test('останавливает разбор без обязательных полей и при разных ID', () => {
  assert.throws(() => parseVacancyPage(vacancyPage({ description: false }), 'empty.html'), /нет ID, названия или описания/);
  assert.throws(() => parseVacancyPage('<h1>Проверка браузера</h1>', 'captcha.html'), /нет ID, названия или описания/);
  assert.throws(() => parseVacancyPage(vacancyPage().replace('spb.hh.ru/vacancy/501', 'hh.ru/vacancy/502'), 'conflict.html'), /ID.*различаются/);
  assert.throws(() => parseVacancyPage(vacancyPage().replaceAll('hh.ru', 'other.example'), 'other.html'), /нет ID, названия или описания/);
  const noCanonical = vacancyPage().replace(/<link rel="canonical"[^>]+>/, '');
  assert.equal(parseVacancyPage(noCanonical, 'saved-url.html').vacancies[0].id, '501');
});

// Интеграционный сценарий проверяет выбор типа страницы и защиту готового JSON при ошибке.
test('CLI разбирает полную вакансию и не перезаписывает результат при неполном исходнике', async () => {
  const temporaryRoot = process.env.CODEX_THREAD_ID
    ? path.join('/workspace/threads', process.env.CODEX_THREAD_ID) : os.tmpdir();
  const directory = await mkdtemp(path.join(temporaryRoot, 'hh-parser-test-'));
  const source = path.join(directory, 'vacancy.html');
  const output = path.join(directory, 'vacancies.json');
  await writeFile(source, vacancyPage());
  const result = await parseFiles([source]);
  assert.deepEqual(result.summary, { file_count: 1, card_count: 1, unique_count: 1, duplicate_count: 0 });
  assert.equal(result.vacancies[0].id, '501');
  const cli = new URL('../scripts/parse-hh.mjs', import.meta.url);
  const success = spawnSync(process.execPath, [cli.pathname, source, output], { encoding: 'utf8' });
  assert.equal(success.status, 0, success.stderr);
  const saved = await readFile(output, 'utf8');
  assert.equal(JSON.parse(saved).vacancies[0].id, '501');
  // При пропавшем заголовке адрес страницы всё ещё отличает её от рекомендательной выдачи.
  await writeFile(source, vacancyPage().replace(/<h1[^>]*>.*?<\/h1>/, ''));
  await assert.rejects(parseFiles([source]), /нет ID, названия или описания/);
  await writeFile(source, vacancyPage({ description: false }));
  const failure = spawnSync(process.execPath, [cli.pathname, source, output], { encoding: 'utf8' });
  assert.equal(failure.status, 1, failure.stderr);
  assert.match(failure.stderr, /описания/);
  assert.equal(await readFile(output, 'utf8'), saved);
});

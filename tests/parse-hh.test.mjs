import assert from 'node:assert/strict';
import test from 'node:test';
import { mergePages, parseSearchPage } from '../scripts/parse-hh.mjs';

// Вымышленная карточка воспроизводит структуру HH без персональных материалов.
function card({ id = '101', title = 'SRE-инженер', salary = true, employer = true } = {}) {
  return `<div data-qa=vacancy-serp__vacancy>
    <a data-qa=serp-item__title href="/vacancy/${id}?query=sre&amp;from=search"><span>${title}</span></a>
    <div class="compensation-labels--example compensation-labels_magritte--example">
      ${salary ? '<span>200&#8239;000 – 300&#8239;000 ₽&nbsp;за&nbsp;месяц, на руки</span>' : ''}
      <div><data data-qa=vacancy-serp__vacancy-work-experience-between3And6>Опыт 3-6 лет</data>
      <span data-qa=vacancy-label-work-schedule-remote>Можно удалённо</span></div>
    </div>
    ${employer === 'anonymous'
      ? '<span data-qa=vacancy-serp__vacancy-employer-text>Компания без публичного профиля</span>'
      : employer ? '<a data-qa=vacancy-serp__vacancy-employer href="/employer/42?dpt=test">ООО&nbsp;Тест &amp; Пример</a>' : ''}
    <span data-qa=vacancy-serp__vacancy-address>Тестовый город</span>
    <span data-qa=address-metro-station-name>Учебная</span>
    <span data-qa=address-metro-station-name></span>
    <span data-qa=address-metro-station-name>Учебная</span>
    <script>НЕ ВКЛЮЧАТЬ В ТЕКСТ</script><style>.hidden { display: none }</style>
  </div>`;
}

// Обёртка имитирует комментарий SingleFile и счётчик страниц поиска.
function page(cards, { total = 1, index = 0, size = 100 } = {}) {
  return `<!doctype html><html><!--
 Page saved with SingleFile
 url: https://hh.ru/search/vacancy?text=sre&items_on_page=${size}&page=${index}
 saved date: Tue Jan 01 2030 12:00:00 GMT+0300
 --><h1>Найдено ${total} вакансий «sre»</h1>
 <div data-qa=vacancy-serp__results>${cards}</div></html>`;
}

// Проверяем поля, HTML-сущности, пробелы и ссылки на карточку и исходник.
test('разбирает HTML SingleFile и сохраняет поля вакансии', () => {
  const result = parseSearchPage(page(card()), 'one.html');
  assert.equal(result.source.page, 1);
  assert.equal(result.source.reported_total, 1);
  assert.equal(result.source.query, 'sre');
  assert.equal(result.source.saved_date, 'Tue Jan 01 2030 12:00:00 GMT+0300');
  assert.deepEqual(result.warnings, []);
  const vacancy = result.vacancies[0];
  assert.equal(vacancy.id, '101');
  assert.equal(vacancy.title, 'SRE-инженер');
  assert.equal(vacancy.url, 'https://hh.ru/vacancy/101');
  assert.equal(vacancy.employer, 'ООО Тест & Пример');
  assert.equal(vacancy.employer_url, 'https://hh.ru/employer/42?dpt=test');
  assert.equal(vacancy.salary, '200 000 – 300 000 ₽ за месяц, на руки');
  assert.equal(vacancy.experience, 'Опыт 3-6 лет');
  assert.equal(vacancy.location, 'Тестовый город');
  assert.deepEqual(vacancy.metro, ['Учебная']);
  assert.deepEqual(vacancy.labels, ['Можно удалённо']);
  assert.deepEqual(vacancy.sources, [{ file: 'one.html', position: 1 }]);
  assert.match(vacancy.card_text, /SRE-инженер 200 000/);
  assert.doesNotMatch(vacancy.card_text, /НЕ ВКЛЮЧАТЬ|display: none/);
});

// Отсутствие зарплаты не подменяем текстом опыта или отметкой удалённой работы.
test('пустые необязательные поля и названия без SRE не теряются', () => {
  const result = parseSearchPage(page(card({ title: 'Инженер платформы', salary: false, employer: false })), 'one.html');
  assert.equal(result.vacancies[0].salary, null);
  assert.equal(result.vacancies[0].employer, null);
  assert.equal(result.vacancies[0].employer_url, null);
  assert.equal(result.vacancies[0].title, 'Инженер платформы');
});

// Название анонимного работодателя тоже важно для последующего отбора.
test('сохраняет подпись работодателя без ссылки на его профиль', () => {
  const result = parseSearchPage(page(card({ employer: 'anonymous' })), 'anonymous.html');
  assert.equal(result.vacancies[0].employer, 'Компания без публичного профиля');
  assert.equal(result.vacancies[0].employer_url, null);
});

// Полная последняя страница может содержать меньше карточек, чем размер выдачи.
test('проверяет количество карточек с учётом номера страницы', () => {
  const complete = parseSearchPage(page(card(), { total: 201, index: 2 }), 'last.html');
  assert.equal(complete.source.page, 3);
  assert.deepEqual(complete.warnings, []);
  const incomplete = parseSearchPage(page(card(), { total: 201 }), 'first.html');
  assert.match(incomplete.warnings[0], /ожидалось 100 карточек, найдено 1/);
});

// Дубли связываем с обеими страницами, включая повторное вхождение на той же странице.
test('объединяет по ID и сохраняет все вхождения без изменения входных данных', () => {
  const first = parseSearchPage(page(card() + card({ id: '102' }), { total: 2 }), 'one.html');
  const second = parseSearchPage(page(card() + card(), { total: 2 }), 'two.html');
  const result = mergePages([first, second]);
  assert.deepEqual(result.summary, { file_count: 2, card_count: 4, unique_count: 2, duplicate_count: 2 });
  assert.deepEqual(result.vacancies[0].sources, [
    { file: 'one.html', position: 1 },
    { file: 'two.html', position: 1 },
    { file: 'two.html', position: 2 },
  ]);
  assert.equal(first.vacancies[0].sources.length, 1);
  assert.deepEqual(result.warnings, []);
});

// Изменённый дубль должен быть заметен, а первые поля остаются воспроизводимыми.
test('сообщает о расхождении полей у одинакового ID', () => {
  const first = parseSearchPage(page(card()), 'one.html');
  const second = parseSearchPage(page(card({ title: 'Senior SRE' })), 'two.html');
  const result = mergePages([first, second]);
  assert.match(result.warnings[0], /101 различается/);
  assert.equal(result.vacancies[0].title, 'SRE-инженер');
});

// Не выдаём ошибочную страницу или повреждённую карточку за успешно разобранную выдачу.
test('отклоняет страницу без карточек и карточку с неверной ссылкой', () => {
  assert.throws(() => parseSearchPage('<h1>Проверка браузера</h1>', 'captcha.html'), /карточки выдачи HH не найдены/);
  assert.throws(() => parseSearchPage(page(card({ id: 'invalid' })), 'bad.html'), /у карточки 1/);
  const missingTitle = page(card({ title: '' }));
  assert.throws(() => parseSearchPage(missingTitle, 'bad.html'), /у карточки 1/);
});

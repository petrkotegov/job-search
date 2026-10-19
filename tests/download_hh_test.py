"""Проверяем остановку загрузчика без запросов к HH."""

import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("download_hh", Path(__file__).parents[1] / "scripts/download-hh.py")
downloader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(downloader)


def vacancy_html(identifier):
    """Создаём вымышленную полную страницу с обязательными признаками."""
    job = {"@type": "JobPosting", "identifier": {"value": identifier},
           "title": "Тестовая вакансия", "description": "<p>Метрики и алерты</p>"}
    return '<h1 data-qa="vacancy-title">Тест</h1><div data-qa="vacancy-description">Метрики</div>' + \
           '<script type="application/ld+json">' + json.dumps(job) + '</script>'


class DownloadTest(unittest.TestCase):
    """Проверяем результаты и число запросов при блокировках и удалённых вакансиях."""

    def run_download(self, responses):
        """Подставляем ответы curl и сохраняем состояние во временную папку."""
        with TemporaryDirectory() as temporary:
            folder = Path(temporary)
            source = folder / "input.json"
            source.write_text(json.dumps([{"id": "501"}, {"id": "502"}]), encoding="utf-8")

            def curl(command, **kwargs):
                """Имитируем curl: пишем HTML и возвращаем его HTTP-статус."""
                status, body = responses.pop(0)
                Path(command[command.index("--output") + 1]).write_text(body, encoding="utf-8")
                return SimpleNamespace(returncode=0, stderr="", stdout=f"{status}\t{command[-1]}\t0.1")

            with patch.object(downloader.subprocess, "run", side_effect=curl) as requests, \
                    patch.object(downloader.time, "sleep") as sleep:
                downloader.download(SimpleNamespace(input=str(source), output=str(folder / "result"), delay=6.5))
            state = json.loads((folder / "result/state.json").read_text(encoding="utf-8"))
            return state, requests.call_count, sleep.call_count

    def test_stops_without_second_request_on_block_or_challenge(self):
        """403, 429 и капча с HTTP 200 должны прекращать загрузку сразу."""
        for status in [403, 429, 200]:
            with self.subTest(status=status):
                state, requests, sleeps = self.run_download([(status, "<h1>Проверка браузера</h1>")])
                self.assertEqual(state["status"], "stopped")
                self.assertEqual(state["saved"], 0)
                self.assertEqual(requests, 1)
                self.assertEqual(sleeps, 0)

    def test_continues_after_unavailable_with_pause(self):
        """Удалённая вакансия учитывается отдельно, следующая скачивается после паузы."""
        state, requests, sleeps = self.run_download([(404, "Не найдено"), (200, vacancy_html("502"))])
        self.assertEqual(state["status"], "completed")
        self.assertEqual(state["unavailable"], 1)
        self.assertEqual(state["saved"], 1)
        self.assertEqual(requests, 2)
        self.assertEqual(sleeps, 1)
        self.assertEqual(len(state["results"][1]["sha256"]), 64)

    def test_stops_on_wrong_vacancy_id(self):
        """Страницу другой вакансии нельзя засчитать как успешную загрузку."""
        state, requests, _ = self.run_download([(200, vacancy_html("999"))])
        self.assertEqual(state["status"], "stopped")
        self.assertEqual(state["saved"], 0)
        self.assertEqual(requests, 1)

    def test_continues_after_explicit_vacancy_access_denial(self):
        """Явный запрет одной вакансии учитывается отдельно и не принимается за бан IP."""
        body = "Вам недоступна эта вакансия. Войдите как пользователь, у которого есть доступ на просмотр"
        state, requests, sleeps = self.run_download([(403, body), (200, vacancy_html("502"))])
        self.assertEqual(state["status"], "completed")
        self.assertEqual(state["restricted"], 1)
        self.assertEqual(state["saved"], 1)
        self.assertEqual(requests, 2)
        self.assertEqual(sleeps, 1)


if __name__ == "__main__":
    unittest.main()

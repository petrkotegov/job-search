#!/usr/bin/env python3
"""Последовательно сохраняем HTML HH; при блокировке прекращаем запросы."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
from html.parser import HTMLParser


class PageMetadata(HTMLParser):
    """Читаем только метаданные, не исполняя скрипты страницы."""

    def __init__(self):
        # Собираем JSON-LD и признаки видимых полей вакансии.
        super().__init__()
        self.scripts = []
        self.current = None
        self.state_current = None
        self.initial_state = ""
        self.qa = set()
        self.canonical = None

    def handle_starttag(self, tag, attrs):
        # Внешние ресурсы и остальные скрипты не загружаем.
        attrs = dict(attrs)
        self.qa.add(attrs.get("data-qa"))
        if tag == "script" and attrs.get("type") == "application/ld+json":
            self.current = []
        if tag == "template" and attrs.get("id") == "HH-Lux-InitialState":
            self.state_current = []
        if tag == "link" and attrs.get("rel") == "canonical":
            self.canonical = attrs.get("href")

    def handle_data(self, data):
        # HTMLParser отдаёт содержимое script без изменения JSON.
        if self.current is not None:
            self.current.append(data)
        if self.state_current is not None:
            self.state_current.append(data)

    def handle_endtag(self, tag):
        # Сохраняем каждый JSON-LD отдельно.
        if tag == "script" and self.current is not None:
            self.scripts.append("".join(self.current))
            self.current = None
        if tag == "template" and self.state_current is not None:
            self.initial_state = "".join(self.state_current)
            self.state_current = None


def inspect_page(html, vacancy_id):
    """Проверяем ID и наличие полного описания в полученной HTML-странице."""
    metadata = PageMetadata()
    metadata.feed(html)
    for source in metadata.scripts:
        try:
            data = json.loads(source)
        except ValueError:
            continue
        for job in data if isinstance(data, list) else [data]:
            if not isinstance(job, dict) or job.get("@type") != "JobPosting":
                continue
            identifier = job.get("identifier", {}).get("value")
            if str(identifier) != str(vacancy_id):
                raise ValueError("ID полученной вакансии не совпадает с запрошенным")
            if not job.get("title") or not job.get("description", "").strip():
                raise ValueError("В JSON-LD отсутствует название или описание")
            if not {"vacancy-title", "vacancy-description"} <= metadata.qa:
                raise ValueError("В HTML отсутствует видимое описание вакансии")
            return {"title": job["title"], "canonical_url": metadata.canonical,
                    "description_html_length": len(job["description"])}
    # Некоторые ответы HH содержат полную вакансию в JSON для клиентского рендера.
    if metadata.initial_state:
        state = json.loads(metadata.initial_state)
        vacancy = state.get("vacancyView", {}).get("vacancyFull", {}).get("vacancy", {})
        if str(vacancy.get("vacancyId")) != str(vacancy_id):
            raise ValueError("ID вакансии в InitialState не совпадает с запрошенным")
        if vacancy.get("name") and vacancy.get("description", "").strip():
            return {"title": vacancy["name"], "canonical_url": metadata.canonical,
                    "description_html_length": len(vacancy["description"]), "data_source": "initial_state"}
    raise ValueError("Не найдена полная вакансия: возможна капча или страница ошибки")


def write_state(folder, state):
    """Атомарно сохраняем прогресс, чтобы его можно было читать во время загрузки."""
    temporary = folder / "state.tmp"
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(folder / "state.json")


def download(args):
    """Загружаем по одному HTML с паузами; блокировки и ошибки не повторяем."""
    items = json.loads(Path(args.input).read_text(encoding="utf-8"))
    folder = Path(args.output)
    (folder / "raw").mkdir(parents=True, exist_ok=True)
    # Защищаемся от случайного повторного запуска того же набора.
    with (folder / "started.json").open("x", encoding="utf-8") as marker:
        json.dump({"pid": os.getpid(), "started_at": time.time()}, marker)
    state = {"status": "running", "pid": os.getpid(), "started_at": time.time(),
             "total": len(items), "processed": 0, "saved": 0, "unavailable": 0, "restricted": 0,
             "delay_seconds": args.delay, "results": []}
    write_state(folder, state)
    for index, item in enumerate(items):
        # Фиксированная пауза ограничивает частоту; параллельных запросов нет.
        if index:
            time.sleep(args.delay)
        vacancy_id = str(item["id"])
        if not vacancy_id.isdecimal():
            raise ValueError("ID вакансии должен состоять из цифр")
        filename = f"vacancy-{vacancy_id}.html"
        target = folder / "raw" / filename
        url = f"https://hh.kz/vacancy/{vacancy_id}"
        row = {"id": vacancy_id, "requested_url": url, "file": f"raw/{filename}",
               "started_at": time.time()}
        try:
            # curl сохраняет исходный ответ; браузер, cookies и ресурсы не требуются.
            result = subprocess.run([
                "curl", "--location", "--max-redirs", "3", "--connect-timeout", "8",
                "--max-time", "35", "--silent", "--show-error", "--output", str(target),
                "--dump-header", str(folder / "raw" / f"vacancy-{vacancy_id}.headers"),
                "--write-out", "%{http_code}\t%{url_effective}\t%{time_total}", url,
            ], capture_output=True, text=True, timeout=45)
            if result.returncode:
                raise ValueError(f"curl {result.returncode}: {result.stderr.strip()}")
            status, effective_url, seconds = result.stdout.strip().split("\t")
            row.update(http_status=int(status), effective_url=effective_url, seconds=float(seconds))
            # Известная страница запрета относится к одной вакансии, а не к бану IP.
            denied = int(status) == 403 and "Вам недоступна эта вакансия" in target.read_text(encoding="utf-8") \
                and "Войдите как пользователь" in target.read_text(encoding="utf-8")
            if int(status) in (403, 429) and not denied:
                raise ValueError(f"Блокировка HTTP {status}; запросы прекращены")
            if denied:
                row.update(status="restricted", reason="Для просмотра этой вакансии требуется право доступа")
                state["restricted"] += 1
            elif int(status) in (404, 410):
                row["status"] = "unavailable"
                state["unavailable"] += 1
            elif int(status) != 200:
                raise ValueError(f"Неожиданный HTTP {status}; запросы прекращены")
            else:
                content = target.read_bytes()
                row.update(inspect_page(content.decode("utf-8"), vacancy_id))
                row.update(status="saved", bytes=len(content), sha256=hashlib.sha256(content).hexdigest())
                state["saved"] += 1
        except Exception as error:
            # Любой сомнительный ответ требует проверки до следующего запроса.
            row.update(status="stopped", error=str(error))
            state.update(status="stopped", reason=str(error))
        state["results"].append(row)
        state["processed"] += 1
        state["updated_at"] = time.time()
        write_state(folder, state)
        print(json.dumps({key: value for key, value in row.items() if key != "sha256"}, ensure_ascii=False), flush=True)
        if state["status"] == "stopped":
            break
    if state["status"] == "running":
        state["status"] = "completed"
    state["finished_at"] = time.time()
    write_state(folder, state)


def main():
    """Принимаем JSON со списком ID и папку для HTML и журнала."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--delay", type=float, default=6.5)
    args = parser.parse_args()
    if args.delay < 1:
        parser.error("Пауза должна быть не меньше одной секунды")
    download(args)


if __name__ == "__main__":
    main()

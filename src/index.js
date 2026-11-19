#!/usr/bin/env node
"use strict";

/**
 * index.js — последовательно скачивает один и тот же URL N раз,
 * замеряет время и объём каждого ответа и печатает среднее время и скорость.
 *
 * Использование:
 *   node src/index.js <url>
 *
 * Зависимостей нет, используется только стандартная библиотека Node.js.
 */

const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");
const { performance } = require("node:perf_hooks");

const ATTEMPTS = 10; // сколько запросов сделать
const MAX_REDIRECTS = 5; // максимум переходов по редиректам на один запрос
const TIMEOUT_MS = 60_000; // таймаут неактивности сокета
const USER_AGENT = "node-download-bench/1.0";

/** Если схема не указана — подставляем https:// */
function normalizeUrl(raw) {
  const s = raw.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
}

/**
 * Один GET-запрос: читает тело до конца и возвращает количество принятых байт.
 * Редиректы отслеживаются (до MAX_REDIRECTS переходов).
 */
function fetchOnce(urlString, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch {
      return reject(new Error(`Некорректный URL: ${urlString}`));
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return reject(new Error(`Неподдерживаемый протокол: ${url.protocol}`));
    }

    const client = url.protocol === "https:" ? https : http;

    const req = client.get(
      url,
      {
        timeout: TIMEOUT_MS,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "*/*",
          "Accept-Encoding": "identity",
        },
      },
      (res) => {
        const { statusCode, statusMessage, headers } = res;

        // Редиректы
        if (
          [301, 302, 303, 307, 308].includes(statusCode) &&
          headers.location
        ) {
          res.resume(); // осушаем тело редиректа
          if (redirectsLeft <= 0) {
            return reject(new Error("Слишком много редиректов"));
          }
          const next = new URL(headers.location, url).toString();
          return fetchOnce(next, redirectsLeft - 1).then(resolve, reject);
        }

        // Не-2xx считаем ошибкой
        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          return reject(
            new Error(
              `HTTP ${statusCode}${statusMessage ? " " + statusMessage : ""}`,
            ),
          );
        }

        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length; // тело никуда не сохраняем, только считаем
        });
        res.on("end", () => resolve(bytes));
        res.on("error", reject);
      },
    );

    req.on("timeout", () =>
      req.destroy(new Error(`Таймаут: нет данных ${TIMEOUT_MS} мс`)),
    );
    req.on("error", reject);
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(2)} ${units[i]}`;
}

function formatDuration(ms) {
  return ms < 1000 ? `${ms.toFixed(1)} мс` : `${(ms / 1000).toFixed(2)} с`;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Использование: node download-bench.js <url>");
    process.exitCode = 1;
    return;
  }

  const target = normalizeUrl(arg);
  console.log(`Цель       : ${target}`);
  console.log(`Запросов   : ${ATTEMPTS} (последовательно)\n`);

  const times = [];
  const sizes = [];
  let failures = 0;

  const wallStart = performance.now();

  for (let i = 1; i <= ATTEMPTS; i++) {
    const started = performance.now();
    try {
      const bytes = await fetchOnce(target);
      const ms = performance.now() - started;

      times.push(ms);
      sizes.push(bytes);

      const speed = bytes / (ms / 1000);
      console.log(
        `[${String(i).padStart(2)}/${ATTEMPTS}] ` +
          `${formatBytes(bytes).padStart(10)} за ${formatDuration(ms).padStart(9)} ` +
          `(${formatBytes(speed)}/s)`,
      );
    } catch (err) {
      failures++;
      console.log(
        `[${String(i).padStart(2)}/${ATTEMPTS}] ошибка: ${err.message}`,
      );
    }
  }

  const wallMs = performance.now() - wallStart;

  const okCount = times.length;
  const totalBytes = sizes.reduce((a, b) => a + b, 0);
  const totalReqMs = times.reduce((a, b) => a + b, 0);

  console.log("\n=== Итог ===");
  console.log(`Успешных запросов  : ${okCount} из ${ATTEMPTS}`);
  if (failures > 0) console.log(`Ошибок             : ${failures}`);

  if (okCount === 0) {
    console.error("Ни один запрос не завершился успешно.");
    process.exitCode = 1;
    return;
  }

  const avgMs = totalReqMs / okCount;
  const seconds = totalReqMs / 1000;
  const mibPerSec = seconds > 0 ? totalBytes / (1024 * 1024) / seconds : 0;
  const mbitPerSec = seconds > 0 ? (totalBytes * 8) / 1e6 / seconds : 0;

  console.log(
    `Скачано всего      : ${formatBytes(totalBytes)} (${totalBytes.toLocaleString("ru-RU")} B)`,
  );
  console.log(
    `Суммарное время    : ${formatDuration(totalReqMs)} ` +
      `(общее время работы: ${formatDuration(wallMs)})`,
  );
  console.log(`Среднее на запрос  : ${formatDuration(avgMs)}`);
  console.log(
    `Скорость скачивания: ${mibPerSec.toFixed(2)} MiB/s (${mbitPerSec.toFixed(2)} Mbit/s)`,
  );
}

main().catch((err) => {
  console.error(`Фатальная ошибка: ${err.message}`);
  process.exitCode = 1;
});

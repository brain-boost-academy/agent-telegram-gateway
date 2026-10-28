import { escapeHtml } from "./markdown.ts";

/** Russian plural: 1 шаг, 2 шага, 5 шагов. */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export function steps(n: number): string {
  return `${n} ${plural(n, "шаг", "шага", "шагов")}`;
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} мин ${s % 60} с` : `${m} мин`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} ч ${m % 60} мин` : `${h} ч`;
}

export function cost(usd: number): string {
  return usd >= 0.01 || usd === 0 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`;
}

export const T = {
  pairingHint:
    "Этот бот работает только с привязанным агентом.\nПопросите агента: «подключи телеграм» — он пришлёт ссылку для привязки.",
  offline: "🔌 агент не в сети",
  queued: (n: number) => `⏳ в очереди: ${n}`,
  waitingForeign: "⏳ агент ещё работает в фоне, отправлю, когда закончит",
  codeUsed: "Этот код уже использован. Попросите агента выпустить новую ссылку.",
  codeExpired: "Код истёк. Попросите агента выпустить новую ссылку.",
  codeUnknown: "Код не найден. Попросите агента выпустить новую ссылку.",
  connectorRevoked: "Этот агент отключён администратором.",
  alreadyPaired: (name: string) => `Агент «${escapeHtml(name)}» уже привязан к вам.`,
  paired: (name: string) =>
    `✅ Агент «${escapeHtml(name)}» подключён.\nПишите сюда — сообщения уйдут агенту. Голосовые и файлы тоже можно. /help — команды.`,
  askRebind: (oldName: string, newName: string) =>
    `Вы уже привязаны к агенту «${escapeHtml(oldName)}». Перепривязать к «${escapeHtml(newName)}»?`,
  rebindDeclined: "Хорошо, привязка не изменилась.",
  waitOwner: "⏳ Ждём подтверждения владельца агента (до 10 минут).",
  ownerAsk: (who: string, name: string) => `🔐 ${escapeHtml(who)} хочет привязаться к агенту «${escapeHtml(name)}».`,
  ownerApproved: (who: string) => `✅ Вы разрешили привязку: ${escapeHtml(who)}. Этот чат больше не управляет агентом.`,
  ownerRejected: (who: string) => `❌ Вы отклонили привязку: ${escapeHtml(who)}.`,
  ownerTimeout: (who: string) => `⌛ Запрос привязки от ${escapeHtml(who)} истёк и отклонён.`,
  newRejected: "❌ Владелец агента отклонил привязку.",
  newTimeout: "⌛ Владелец не ответил за 10 минут — привязка отклонена.",
  newStale: "Запрос привязки устарел: владелец агента сменился. Попросите агента выпустить новую ссылку.",
  justClaimed: (name: string) => `⚠️ Агента «${escapeHtml(name)}» только что привязал другой пользователь. Попросите агента выпустить новую ссылку.`,
  lostToOther: (name: string) => `ℹ️ Агент «${escapeHtml(name)}» больше не привязан к этому чату.`,
  unpaired: (name: string) => `Агент «${escapeHtml(name)}» отвязан от этого чата.`,
  adminUnpaired: (name: string) => `Администратор отвязал агента «${escapeHtml(name)}» от этого чата.`,
  agentUnpaired: (name: string) => `Агент «${escapeHtml(name)}» отвязал этот чат.`,
  replaceAlert: (name: string, ips: string[]) =>
    `⚠️ к агенту «${escapeHtml(name)}» подключаются из двух мест (IP ${escapeHtml(ips.join(", "))}). Если это не вы, напишите администратору`,
  stale: "Запрос устарел",
  closed: "Запрос уже закрыт",
  noAccess: "Нет доступа",
  asrFailed: "Не удалось распознать",
  asrOff: "Распознавание голоса не настроено",
  tooBigDownload: "Файл больше 20 МБ — Telegram не даёт боту его скачать.",
  tooBigForAgent: "Файл слишком большой для агента.",
  uploadFailed: "Не удалось передать файл агенту.",
  armPrompt: "✍️ Напишите ответ одним сообщением",
  armCancelled: "Ответ отменён.",
  needNumber: "Нужно число. Напишите ответ ещё раз.",
  needOption: "Такого варианта нет. Напишите один из вариантов или нажмите кнопку.",
  error: (msg: string) => `⚠️ ${escapeHtml(msg)}`,
  help: [
    "<b>Команды</b>",
    "/new — новая сессия",
    "/sessions — последние сессии",
    "/stop — остановить текущий ответ",
    "/mode — режим разрешений",
    "/agent — выбрать агента",
    "/verbose — показывать каждый вызов инструмента (on/off)",
    "/status — состояние агента",
    "/unpair — отвязать агента от этого чата",
    "",
    "Просто пишите текстом, голосом или присылайте файлы. Ответ (reply) на сообщение агента продолжает ту сессию, из которой оно пришло.",
  ].join("\n"),
} as const;

export const COMMANDS = [
  { command: "start", description: "привязать агента / приветствие" },
  { command: "new", description: "новая сессия" },
  { command: "sessions", description: "последние сессии" },
  { command: "stop", description: "остановить ответ" },
  { command: "mode", description: "режим разрешений" },
  { command: "agent", description: "выбрать агента" },
  { command: "verbose", description: "подробный вывод инструментов" },
  { command: "status", description: "состояние агента" },
  { command: "unpair", description: "отвязать агента" },
  { command: "help", description: "справка" },
];

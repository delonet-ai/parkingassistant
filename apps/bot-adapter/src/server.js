'use strict';

const http = require('node:http');
const { URL } = require('node:url');

const port = Number(process.env.PORT || 3200);
const apiBaseUrl = process.env.API_BASE_URL || 'http://api:3000';
const appTimezone = process.env.APP_TIMEZONE || 'Europe/Moscow';

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString('utf8').trim();
  return rawBody ? JSON.parse(rawBody) : {};
}

function currentDateInTimezone(timeZone = appTimezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function addDaysToIsoDate(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  const nextDate = new Date(Date.UTC(year, month - 1, day + days));
  return nextDate.toISOString().slice(0, 10);
}

async function fetchJson(pathname) {
  const response = await fetch(`${apiBaseUrl}${pathname}`);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const error = new Error(data.error || `API error ${response.status}`);
    error.statusCode = response.status;
    error.payload = data;
    throw error;
  }

  return data;
}

async function postJson(pathname, payload) {
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const error = new Error(data.error || `API error ${response.status}`);
    error.statusCode = response.status;
    error.payload = data;
    throw error;
  }

  return data;
}

function extractMessengerUserId(payload) {
  return (
    payload.messengerUserId ||
    payload.yandexMessengerUserId ||
    payload.userId ||
    payload.from?.id ||
    payload.sender?.id ||
    payload.message?.from?.id ||
    payload.event?.from?.id ||
    null
  );
}

function extractText(payload) {
  return (
    payload.text ||
    payload.command ||
    payload.message?.text ||
    payload.event?.message?.text ||
    ''
  ).trim();
}

async function resolveEmployee(messengerUserId) {
  const today = currentDateInTimezone();
  const employees = await fetchJson(`/admin/employees?date=${encodeURIComponent(today)}`);
  return (employees.employees || []).find((employee) => employee.yandexMessengerUserId === messengerUserId) || null;
}

function helpText() {
  return [
    'Доступные команды:',
    'статус',
    'выезд HH:MM',
    'выезд YYYY-MM-DD HH:MM',
    'контакты',
    'контакты YYYY-MM-DD'
  ].join('\n');
}

function formatContacts(contacts) {
  if (!contacts.length) {
    return 'Перед вами никого нет.';
  }

  return contacts
    .map((contact) => {
      if (contact.subjectType === 'guest') {
        return `Позиция ${contact.position}: впереди гость. ${contact.message}`;
      }

      const phone = contact.user.phone ? `, телефон: ${contact.user.phone}` : '';
      const email = contact.user.email ? `, email: ${contact.user.email}` : '';
      return `Позиция ${contact.position}: ${contact.user.displayName}${phone}${email}`;
    })
    .join('\n');
}

async function handleCommand({ messengerUserId, text }) {
  if (!messengerUserId) {
    return {
      text: 'Не удалось определить пользователя Yandex Messenger.'
    };
  }

  const employee = await resolveEmployee(messengerUserId);

  if (!employee) {
    return {
      text: 'Ваш Messenger ID не привязан к сотруднику. Обратитесь к администратору парковки.'
    };
  }

  const normalized = text.toLowerCase();
  const today = currentDateInTimezone();
  const tomorrow = addDaysToIsoDate(today, 1);

  if (!normalized || normalized === 'help' || normalized === 'помощь') {
    return { text: helpText() };
  }

  if (normalized === 'статус') {
    const permanent = employee.permanentPlace ? `Постоянное место: ${employee.permanentPlace.code}` : 'Постоянного места нет';
    return {
      text: `${employee.displayName}\n${permanent}`
    };
  }

  const departureMatch = normalized.match(/^выезд\s+(?:(\d{4}-\d{2}-\d{2})\s+)?(\d{2}:\d{2})$/);
  if (departureMatch) {
    const planDate = departureMatch[1] || tomorrow;
    const departureTime = departureMatch[2];
    const result = await postJson('/bot/departure-plans', {
      userId: employee.id,
      planDate,
      departureTime
    });

    return {
      text: `Время выезда сохранено: ${result.departurePlan.planDate} ${result.departurePlan.departureTime}${result.departurePlan.isEarly ? ' (ранний)' : ''}.`
    };
  }

  const contactsMatch = normalized.match(/^контакты(?:\s+(\d{4}-\d{2}-\d{2}))?$/);
  if (contactsMatch) {
    const date = contactsMatch[1] || today;
    const result = await fetchJson(`/bot/line/blocking-contacts?requesterUserId=${encodeURIComponent(employee.id)}&date=${encodeURIComponent(date)}`);

    return {
      text: formatContacts(result.contacts || [])
    };
  }

  return { text: helpText() };
}

async function handleIncomingCommand(req) {
  const payload = await readJsonBody(req);
  const messengerUserId = extractMessengerUserId(payload);
  const text = extractText(payload);
  const response = await handleCommand({ messengerUserId, text });

  return {
    statusCode: 200,
    payload: {
      status: 'ok',
      service: 'bot-adapter',
      messengerUserId,
      text,
      response
    }
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      service: 'bot-adapter',
      timestamp: new Date().toISOString()
    });
    return;
  }

  if (req.method === 'POST' && (url.pathname === '/webhook/yandex' || url.pathname === '/bot/test-command')) {
    try {
      const result = await handleIncomingCommand(req);
      sendJson(res, result.statusCode, result.payload);
    } catch (error) {
      sendJson(res, error.statusCode || 500, {
        status: 'error',
        service: 'bot-adapter',
        error: error.message,
        details: error.payload || null
      });
    }
    return;
  }

  sendJson(res, 404, {
    status: 'error',
    service: 'bot-adapter',
    error: 'Not found'
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`parkingassistant bot-adapter listening on port ${port}`);
});

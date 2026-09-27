

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Bot is alive ✅", { status: 200 });
    }

    let update;
    try {
      update = await request.json();
    } catch (e) {
      return new Response("Bad request", { status: 400 });
    }

    console.log("Update received:", JSON.stringify(update).slice(0, 500));

    try {
      if (update.callback_query) {
        await handleCallback(env, update.callback_query);
        return new Response("OK");
      }

      const message = update.message;
      if (!message || !message.text) {
        return new Response("OK");
      }

      const chatId = message.chat.id;
      const userId = message.from.id;
      const username = message.from.username || message.from.first_name || "بدون‌نام";
      const text = stripBotMention(message.text.trim());

      let replyText;

      if (text.startsWith("/add")) {
        replyText = await handleAdd(env, chatId, userId, username, text);
      } else if (text === "/members") {
        replyText = await handleMembers(env, chatId);
      } else if (text === "/expense") {
        await sendExpenseMenu(env.BOT_TOKEN, chatId);
        return new Response("OK");
      } else if (text === "/balance") {
        replyText = await handleBalance(env, chatId);
      } else if (text.startsWith("/settle")) {
        replyText = await handleSettle(env, chatId, userId, text);
      } else if (text === "/history") {
        replyText = await handleHistory(env, chatId);
      } else if (text === "/cancel") {
        await clearPending(env, chatId, userId);
        replyText = "لغو شد.";
      } else if (text === "/restart") {
        replyText = await handleRestart(env, chatId);
      } else if (text === "/start") {
        replyText = startText();
      } else if (text === "/help") {
        replyText = helpText();
      } else if (!text.startsWith("/")) {
        
        const pending = await getPending(env, chatId, userId);
        if (!pending) {
          return new Response("OK");
        }
        replyText = await handleExpenseInput(env, chatId, userId, pending.type, text);
        await clearPending(env, chatId, userId);
      } else {
        return new Response("OK");
      }

      await sendMessage(env.BOT_TOKEN, chatId, replyText);
      return new Response("OK");
    } catch (err) {
      
      const chatId = update?.message?.chat?.id || update?.callback_query?.message?.chat?.id;
      if (chatId) {
        await sendMessage(env.BOT_TOKEN, chatId, `⚠️ خطا: ${err.message}`);
      }
      return new Response("OK");
    }
  },
};

async function sendExpenseMenu(botToken, chatId) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: "چطور می‌خوای این هزینه رو تقسیم کنی؟",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔹 تقسیم مساوی بین همه‌ی اعضا", callback_data: "exp_all" }],
          [{ text: "🔺 تقسیم غیرمساوی (سهم دلخواه)", callback_data: "exp_custom" }],
        ],
      },
    }),
  });
}

async function handleCallback(env, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;

  await answerCallback(env.BOT_TOKEN, callbackQuery.id);

  const typeMap = { exp_all: "all", exp_custom: "custom" };
  const type = typeMap[data];
  if (!type) return;

  await setPending(env, chatId, userId, { type });

  const prompts = {
    all:
      "مبلغ رو تو خط اول بفرست و توضیح رو تو خط دوم. مثال:\n90000\nخرید نون",
    custom:
      "هر خط: اسم شخص و سهمش\nخط آخر: توضیح\n\nمثال:\nعلی 20000\nرضا 15000\nمریم 25000\nپیتزا",
  };

  await sendMessage(env.BOT_TOKEN, chatId, prompts[type] + "\n\n(برای لغو /cancel رو بزن)");
}

async function handleExpenseInput(env, chatId, payerId, type, text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  if (type === "all") {
    if (lines.length < 2) {
      throw new Error("باید حداقل مبلغ (خط اول) و توضیح (خط دوم) رو بفرستی.");
    }
    const amount = parseAmount(lines[0]);
    const description = lines.slice(1).join(" ");

    const members = await getMembers(env, chatId);
    if (members.length === 0) throw new Error("هنوز هیچ عضوی ثبت نشده. اول از /add استفاده کنید.");
    const payer = requirePayer(members, payerId);

    const perPerson = amount / members.length;
    const shares = members.map((m) => ({ userId: m.userId, nickname: m.nickname, amount: perPerson }));

    await applyExpense(env, chatId, payerId, payer.nickname, description, amount, shares);

    return (
      `✅ هزینه ثبت شد: «${description}» - ${formatMoney(amount)} تومان\n` +
      `پرداخت‌کننده: ${payer.nickname}\n` +
      `تقسیم مساوی بین ${members.length} نفر (هر نفر ${formatMoney(perPerson)} تومان):\n` +
      formatSharesListCredit(shares, payerId, payer.nickname, amount)
    );
  }

  if (type === "custom") {
    if (lines.length < 2) {
      throw new Error("باید حداقل یه ردیف «اسم مبلغ» و یه خط توضیح بفرستی.");
    }
    const description = lines[lines.length - 1];
    const shareLines = lines.slice(0, -1);

    const members = await getMembers(env, chatId);
    const payer = requirePayer(members, payerId);

    const shares = [];
    let total = 0;
    for (const line of shareLines) {
      const tokens = line.split(/\s+/);
      if (tokens.length < 2) {
        throw new Error(`این خط معتبر نیست: «${line}». فرمت درست: اسم مبلغ`);
      }
      const amt = parseAmount(tokens[tokens.length - 1]);
      const name = tokens.slice(0, -1).join(" ");
      const member = requireMemberByName(members, name);
      shares.push({ userId: member.userId, nickname: member.nickname, amount: amt });
      total += amt;
    }

    await applyExpense(env, chatId, payerId, payer.nickname, description, total, shares);

    return (
      `✅ هزینه ثبت شد: «${description}» - مجموع ${formatMoney(total)} تومان\n` +
      `پرداخت‌کننده: ${payer.nickname}\n` +
      `سهم هرکس:\n` +
      formatSharesListCredit(shares, payerId, payer.nickname, total)
    );
  }

  throw new Error("نوع نامعتبر.");
}


async function handleAdd(env, chatId, userId, username, text) {
  const nickname = text.slice(4).trim();
  if (!nickname) throw new Error("لطفاً یه اسم مستعار هم بنویس. مثال:\n/add علی");

  const members = await getMembers(env, chatId);
  const existing = members.find((m) => m.userId === userId);

  if (existing) {
    existing.nickname = nickname;
    await saveMembers(env, chatId, members);
    return `✅ اسم مستعارت به‌روزرسانی شد: ${nickname}`;
  }

  members.push({ userId, username, nickname });
  await saveMembers(env, chatId, members);

  const balances = await getBalances(env, chatId);
  if (!(userId in balances)) {
    balances[userId] = 0;
    await saveBalances(env, chatId, balances);
  }

  return `✅ ${nickname} با موفقیت به سیستم حساب‌وکتاب این اتاق اضافه شد.`;
}

async function handleMembers(env, chatId) {
  const members = await getMembers(env, chatId);
  if (members.length === 0) return "هنوز کسی عضو نشده. برای عضویت دستور /add <اسم مستعار> رو بزن.";
  return "👥 اعضای این اتاق:\n" + members.map((m, i) => `${i + 1}. ${m.nickname}`).join("\n");
}

async function handleBalance(env, chatId) {
  const members = await getMembers(env, chatId);
  const balances = await getBalances(env, chatId);
  if (members.length === 0) return "هنوز هیچ عضوی ثبت نشده.";

  const lines = members.map((m) => {
    const bal = balances[m.userId] || 0;
    if (bal > 0.5) return `🟢 ${m.nickname}: طلبکار ${formatMoney(bal)} تومان`;
    if (bal < -0.5) return `🔴 ${m.nickname}: بدهکار ${formatMoney(-bal)} تومان`;
    return `⚪ ${m.nickname}: تسویه`;
  });

  return "💰 وضعیت حساب‌وکتاب:\n" + lines.join("\n");
}

async function handleSettle(env, chatId, senderId, text) {
  const rest = text.replace("/settle", "").trim();
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    throw new Error(
      "فرمت درست:\n/settle <نام گیرنده> <مبلغ>\nمثال:\n/settle علی 200000\n\n(یعنی تو داری ۲۰۰,۰۰۰ تومان برای علی واریز می‌کنی)"
    );
  }
  const amount = parseAmount(tokens[tokens.length - 1]);
  const receiverName = tokens.slice(0, -1).join(" ");

  const members = await getMembers(env, chatId);
  const sender = requirePayer(members, senderId);
  const receiver = requireMemberByName(members, receiverName);

  if (receiver.userId === senderId) {
    throw new Error("نمی‌تونی برای خودت تسویه ثبت کنی.");
  }

  const balances = await getBalances(env, chatId);
  balances[senderId] = (balances[senderId] || 0) + amount;
  balances[receiver.userId] = (balances[receiver.userId] || 0) - amount;
  await saveBalances(env, chatId, balances);

  const history = await getHistory(env, chatId);
  history.push({
    type: "settlement",
    fromUserId: senderId,
    fromNickname: sender.nickname,
    toUserId: receiver.userId,
    toNickname: receiver.nickname,
    amount,
    ts: Date.now(),
  });
  await saveHistory(env, chatId, history);

  return (
    `✅ تسویه ثبت شد: ${sender.nickname} → ${receiver.nickname} به‌مبلغ ${formatMoney(amount)} تومان\n` +
    `وضعیت جدید:\n` +
    `${sender.nickname}: ${balanceLine(balances[senderId])}\n` +
    `${receiver.nickname}: ${balanceLine(balances[receiver.userId])}`
  );
}

function balanceLine(bal) {
  if (bal > 0.5) return `طلبکار ${formatMoney(bal)} تومان`;
  if (bal < -0.5) return `بدهکار ${formatMoney(-bal)} تومان`;
  return "تسویه";
}

async function handleRestart(env, chatId) {
  const balances = await getBalances(env, chatId);
  for (const key of Object.keys(balances)) {
    balances[key] = 0;
  }
  await saveBalances(env, chatId, balances);

  const history = await getHistory(env, chatId);
  history.push({ type: "restart", ts: Date.now() });
  await saveHistory(env, chatId, history);

  return "🔄 تمام بدهی‌ها و طلب‌های این اتاق صفر شد.";
}

async function handleHistory(env, chatId) {
  const history = await getHistory(env, chatId);
  if (history.length === 0) return "هنوز هیچ تراکنشی ثبت نشده.";

  const recent = history.slice(-15).reverse();
  const lines = recent.map((h) => {
    const date = new Date(h.ts).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" });
    if (h.type === "settlement") {
      return `💵 تسویه: ${h.fromNickname} → ${h.toNickname} به‌مبلغ ${formatMoney(h.amount)} تومان\n   ${date}`;
    }
    if (h.type === "restart") {
      return `🔄 صفر شدن همه‌ی حساب‌ها\n   ${date}`;
    }
    const payerName = h.payerNickname || "?";
    return `📌 «${h.description}» - ${formatMoney(h.amount)} تومان (پرداخت: ${payerName})\n   ${date}`;
  });

  return "🕒 تاریخچه‌ی اخیر:\n\n" + lines.join("\n\n");
}


async function applyExpense(env, chatId, payerId, payerNickname, description, amount, shares) {
  const balances = await getBalances(env, chatId);

  balances[payerId] = (balances[payerId] || 0) + amount;

  for (const s of shares) {
    balances[s.userId] = (balances[s.userId] || 0) - s.amount;
  }

  await saveBalances(env, chatId, balances);

  const history = await getHistory(env, chatId);
  history.push({ type: "expense", payerId, payerNickname, description, amount, shares, ts: Date.now() });
  await saveHistory(env, chatId, history);
}

function formatSharesListCredit(shares, payerId, payerNickname, totalAmount) {
  const payerShare = shares.find((s) => s.userId === payerId);
  const creditAmount = totalAmount - (payerShare ? payerShare.amount : 0);

  const lines = [`• ${payerNickname} (پرداخت‌کننده): طلبکار ${formatMoney(creditAmount)} تومان`];

  for (const s of shares) {
    if (s.userId === payerId) continue; 
    lines.push(`• ${s.nickname}: بدهکار ${formatMoney(s.amount)} تومان`);
  }

  return lines.join("\n");
}

function requirePayer(members, payerId) {
  const payer = members.find((m) => m.userId === payerId);
  if (!payer) throw new Error("اول باید با دستور /add <اسم مستعار> عضو بشی.");
  return payer;
}

function requireMemberByName(members, name) {
  const normalized = name.trim().toLowerCase();
  const member = members.find((m) => m.nickname.trim().toLowerCase() === normalized);
  if (!member) throw new Error(`عضوی به اسم «${name}» پیدا نشد. اول باید اون شخص /add بزنه.`);
  return member;
}

function stripBotMention(text) {
  if (!text.startsWith("/")) return text;
  const spaceIdx = text.indexOf(" ");
  let command = spaceIdx === -1 ? text : text.slice(0, spaceIdx);
  const atIdx = command.indexOf("@");
  if (atIdx !== -1) command = command.slice(0, atIdx);
  return spaceIdx === -1 ? command : command + text.slice(spaceIdx);
}

function toEnglishDigits(str) {
  const persian = "۰۱۲۳۴۵۶۷۸۹";
  const arabic = "٠١٢٣٤٥٦٧٨٩";
  return str.replace(/[۰-۹٠-٩]/g, (ch) => {
    let idx = persian.indexOf(ch);
    if (idx !== -1) return String(idx);
    idx = arabic.indexOf(ch);
    if (idx !== -1) return String(idx);
    return ch;
  });
}

function parseAmount(str) {
  const converted = toEnglishDigits(String(str));
  const n = parseFloat(converted.replace(/,/g, ""));
  if (isNaN(n) || n <= 0) throw new Error(`مبلغ «${str}» معتبر نیست.`);
  return n;
}

function formatMoney(n) {
  return Math.round(n).toLocaleString("fa-IR");
}

function startText() {
  return (
    "سلام! 👋 من بات مدیریت هزینه‌های اتاق هستم.\n\n" +
    "اول با دستور زیر عضو شو:\n/add <اسم مستعار>\n\n" +
    "برای دیدن همه‌ی دستورات: /help"
  );
}

function helpText() {
  const sep = "───────────────";
  return (
    "📖 راهنمای بات مدیریت هزینه‌های اتاق\n" +
    sep +
    "\n\n" +
    "👤 عضویت\n" +
    "/add <اسم مستعار>\n" +
    "عضویت در سیستم، یا تغییر اسم مستعار\n\n" +
    sep +
    "\n\n" +
    "👥 اعضا\n" +
    "/members\n" +
    "نمایش لیست اعضای ثبت‌شده\n\n" +
    sep +
    "\n\n" +
    "💸 ثبت هزینه\n" +
    "/expense\n" +
    "شروع ثبت یک هزینه‌ی جدید (با دکمه‌های تعاملی)\n\n" +
    sep +
    "\n\n" +
    "💰 وضعیت حساب\n" +
    "/balance\n" +
    "نمایش بدهی/طلب هرکس\n\n" +
    sep +
    "\n\n" +
    "✅ تسویه‌حساب\n" +
    "/settle <نام گیرنده> <مبلغ>\n" +
    "یعنی داری برای اون شخص پول واریز می‌کنی (خودت طلبکار، اون بدهکار می‌شه)\n" +
    "مثال: /settle علی 200000\n\n" +
    sep +
    "\n\n" +
    "🕒 تاریخچه\n" +
    "/history\n" +
    "نمایش ۱۵ تراکنش اخیر\n\n" +
    sep +
    "\n\n" +
    "❌ لغو عملیات\n" +
    "/cancel\n" +
    "لغو فرآیند ثبت هزینه‌ی نیمه‌کاره"
  );
}


async function getMembers(env, chatId) {
  const raw = await env.ROOM_DB.get(`members:${chatId}`);
  return raw ? JSON.parse(raw) : [];
}
async function saveMembers(env, chatId, members) {
  await env.ROOM_DB.put(`members:${chatId}`, JSON.stringify(members));
}

async function getBalances(env, chatId) {
  const raw = await env.ROOM_DB.get(`balances:${chatId}`);
  return raw ? JSON.parse(raw) : {};
}
async function saveBalances(env, chatId, balances) {
  await env.ROOM_DB.put(`balances:${chatId}`, JSON.stringify(balances));
}

async function getHistory(env, chatId) {
  const raw = await env.ROOM_DB.get(`history:${chatId}`);
  return raw ? JSON.parse(raw) : [];
}
async function saveHistory(env, chatId, history) {
  await env.ROOM_DB.put(`history:${chatId}`, JSON.stringify(history));
}

async function getPending(env, chatId, userId) {
  const raw = await env.ROOM_DB.get(`pending:${chatId}:${userId}`);
  return raw ? JSON.parse(raw) : null;
}
async function setPending(env, chatId, userId, value) {
  await env.ROOM_DB.put(`pending:${chatId}:${userId}`, JSON.stringify(value), { expirationTtl: 600 });
}
async function clearPending(env, chatId, userId) {
  await env.ROOM_DB.delete(`pending:${chatId}:${userId}`);
}


async function sendMessage(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("sendMessage failed:", res.status, body);
  }
}

async function answerCallback(botToken, callbackQueryId) {
  const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}

// Channel self-registration barrel file.
// Each import triggers the channel module's registerChannel() call.

// discord

// gmail

// slack

// telegram
import './telegram.js';

// whatsapp — disabled (Telegram-only setup). The WhatsApp channel always
// loads and calls process.exit() on a 401 logout, which crash-loops the
// service under launchd KeepAlive. Re-enable by restoring this import and
// re-authenticating via /add-whatsapp.
// import './whatsapp.js';

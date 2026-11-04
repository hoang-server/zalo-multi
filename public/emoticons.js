// Mã biểu tượng cảm xúc kiểu cũ của Zalo (gõ từ bảng icon trên app Zalo) → emoji Unicode gần nghĩa nhất.
// Dùng chung cho giao diện và server (xem trước tin nhắn, thông báo push).
const MAP = {
  ":)": "🙂", ":~": "😕", ":b": "😋", ":')": "🥲", "8-)": "😎", ":-((": "😭", ":$": "😳", ":3": "😊",
  ":z": "😴", ":((": "😢", "&-(": "😖", ":-h": "😡", ":p": "😛", ":d": "😃", ":o": "😮", ":(": "🙁",
  ";-)": "😉", "--b": "😓", ":))": "😆", ":-*": "😘", ";p": "😜", ";-d": "😁", "/-showlove": "🥰", ";d": "😂",
  ";o": "😲", ";g": "😬", "|-)": "😪", ":!": "😱", ":l": "😑", ":>": "😆", ":;": "😅", ";f": "😏",
  ":v": "😄", ":wipe": "😥", ":-dig": "🤭", ":handclap": "👏", ":hanclap": "👏", "b-)": "😎", ":-r": "🤮", ":-<": "😞",
  ":-o": "😮", ";-s": "😖", ";?": "🤔", ";-x": "🤐", ":-f": "😤", "8*)": "🙄", ";!": "😠", ";-!": "😵",
  ";xx": "😵‍💫", ":-bye": "👋", ">-|": "😒", "p-(": "🥺", ":--|": "😐", ":q": "🤤", "x-)": "😵", ":*": "😗",
  ";-a": "😇", "8*": "🤩", ":|": "😐", ":x": "😍", ":t": "😤", ";-/": "😕", ":-l": "😑", "$-)": "🤑",
  ";8": "😎", ":-|": "😐", ":+": "😚", "_()_": "🙏",
  "/-beer": "🍺", "/-coffee": "☕", "/-rose": "🌹", "/-fade": "🥀", "/-bd": "🎉", "/-bome": "💣", "/-cake": "🎂",
  "/-heart": "❤️", "/-break": "💔", "/-shit": "💩", "/-li": "⚡", "/-flag": "🚩", "/-strong": "👍", "/-weak": "👎",
  "/-ok": "👌", "/-v": "✌️", "/-thanks": "🙇", "/-punch": "👊", "/-share": "🤝", "/-no": "🙅", "/-bad": "😈",
  "/-loveu": "🤟",
};
// Mã dạng :ten: (bảng emoji mới) – chỉ những mã hay gặp; mã lạ giữ nguyên chữ
const NAMED = {
  grinning: "😀", grin: "😁", joy: "😂", smiley: "😃", smile: "😄", sweat_smile: "😅", laughing: "😆", wink: "😉",
  blush: "😊", heart_eyes: "😍", kissing_heart: "😘", sunglasses: "😎", thinking_face: "🤔", cry: "😢", sob: "😭",
  angry: "😠", rage: "😡", scream: "😱", "+1": "👍", "-1": "👎", ok_hand: "👌", clap: "👏", pray: "🙏", heart: "❤️",
  fire: "🔥", tada: "🎉", rose: "🌹", wave: "👋", muscle: "💪", v: "✌️", sleeping: "😴", hugging_face: "🤗",
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const codes = Object.keys(MAP).sort((a, b) => b.length - a.length).map(esc).join("|");
// Chỉ thay khi mã đứng riêng (đầu dòng/sau khoảng trắng và trước khoảng trắng/cuối) để không phá link, giờ "8:30"...
const RE = new RegExp(`(^|\\s)(${codes})(?=\\s|$)`, "gi");
const RE_NAMED = /:([a-z0-9_+-]+):/g;

export function emoticons(text) {
  if (!text) return text;
  return text
    .replace(RE, (m, pre, code) => pre + (MAP[code.toLowerCase()] || code))
    .replace(RE_NAMED, (m, n) => NAMED[n] || m);
}

// Cienka warstwa nad mostem z preload.js: rozpakowuje { ok, data } i rzuca błędy.
export async function call(channel, ...args) {
  const res = await window.crown.invoke(channel, ...args);
  if (!res || !res.ok) throw new Error(res?.error || 'Nieznany błąd');
  return res.data;
}

export const on = (channel, callback) => window.crown.on(channel, callback);

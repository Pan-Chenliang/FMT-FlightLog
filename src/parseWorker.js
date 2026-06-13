import { parseMlog } from "./mlogParser.js";

self.addEventListener("message", (event) => {
  const { buffer } = event.data ?? {};

  try {
    const result = parseMlog(buffer);
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: {
        message: error?.message ?? String(error),
      },
    });
  }
});

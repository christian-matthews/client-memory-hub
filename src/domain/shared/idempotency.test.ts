import { describe, expect, it } from "vitest";
import { compact, hashPayload, stableStringify } from "./idempotency";

describe("stableStringify", () => {
  it("es independiente del orden de las claves", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it("respeta el orden de los arreglos", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it("ignora claves undefined pero conserva null", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
    expect(stableStringify({ a: null })).not.toBe(stableStringify({}));
  });

  it("ordena claves anidadas", () => {
    expect(stableStringify({ x: { p: 1, q: 2 } })).toBe(stableStringify({ x: { q: 2, p: 1 } }));
  });
});

describe("hashPayload", () => {
  it("produce el mismo hash para payloads equivalentes", async () => {
    const a = await hashPayload({ topicId: "t1", content: "hola", extra: undefined });
    const b = await hashPayload({ content: "hola", topicId: "t1" });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("cambia el hash cuando cambia el contenido", async () => {
    expect(await hashPayload({ content: "hola" })).not.toBe(await hashPayload({ content: "hola." }));
  });
});

describe("compact", () => {
  it("elimina claves undefined y conserva null y false", () => {
    expect(compact({ a: 1, b: undefined, c: null, d: false })).toEqual({ a: 1, c: null, d: false });
  });
});

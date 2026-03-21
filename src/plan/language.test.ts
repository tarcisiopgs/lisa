import { describe, expect, it } from "vitest";
import { detectLanguage, languageName } from "./language.js";

describe("detectLanguage", () => {
	it('detects Portuguese from "Adicionar rate limiting na API"', () => {
		expect(detectLanguage("Adicionar rate limiting na API")).toBe("pt");
	});

	it('detects English from "Add rate limiting to the API"', () => {
		expect(detectLanguage("Add rate limiting to the API")).toBe("en");
	});

	it("detects Spanish", () => {
		expect(detectLanguage("Agregar limitación de velocidad a la API también")).toBe("es");
	});

	it("detects Portuguese with accented stop words", () => {
		expect(detectLanguage("Não deve fazer isso após a mudança")).toBe("pt");
	});

	it("defaults to English for very short input", () => {
		expect(detectLanguage("fix bug")).toBe("en");
	});

	it("defaults to English for empty input", () => {
		expect(detectLanguage("")).toBe("en");
	});

	it("detects Portuguese with mixed technical terms", () => {
		expect(detectLanguage("Adicionar paginação nos endpoints de listagem apenas")).toBe("pt");
	});

	it("detects English with common stop words", () => {
		expect(
			detectLanguage("Create a middleware that handles each request through the pipeline"),
		).toBe("en");
	});

	it("handles input with special characters", () => {
		expect(detectLanguage("Corrigir bug — não está funcionando")).toBe("pt");
	});
});

describe("languageName", () => {
	it("returns Portuguese for pt", () => {
		expect(languageName("pt")).toBe("Portuguese");
	});

	it("returns English for en", () => {
		expect(languageName("en")).toBe("English");
	});

	it("returns Spanish for es", () => {
		expect(languageName("es")).toBe("Spanish");
	});

	it("defaults to English for unknown codes", () => {
		expect(languageName("xx")).toBe("English");
	});
});

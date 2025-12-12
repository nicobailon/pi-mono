import { describe, expect, test } from "vitest";
import { parseFrontmatter } from "../src/core/skills.js";

describe("parseFrontmatter", () => {
	describe("valid frontmatter", () => {
		test("parses name and description", () => {
			const content = `---
name: my-skill
description: A helpful skill
---

# Body content`;
			const result = parseFrontmatter(content);
			expect(result.frontmatter.name).toBe("my-skill");
			expect(result.frontmatter.description).toBe("A helpful skill");
			expect(result.body).toBe("# Body content");
		});

		test("parses quoted values", () => {
			const content = `---
name: "quoted-name"
description: "A quoted description"
---

Body`;
			const result = parseFrontmatter(content);
			expect(result.frontmatter.name).toBe("quoted-name");
			expect(result.frontmatter.description).toBe("A quoted description");
		});

		test("parses single-quoted values", () => {
			const content = `---
name: 'single-quoted'
description: 'Single quoted description'
---

Body`;
			const result = parseFrontmatter(content);
			expect(result.frontmatter.name).toBe("single-quoted");
			expect(result.frontmatter.description).toBe("Single quoted description");
		});

		test("handles description with colons", () => {
			const content = `---
name: test-skill
description: Use for: PDFs, DOCs, and spreadsheets
---

Body`;
			const result = parseFrontmatter(content);
			expect(result.frontmatter.description).toBe("Use for: PDFs, DOCs, and spreadsheets");
		});

		test("handles hyphenated names", () => {
			const content = `---
name: my-awesome-skill
description: Does things
---

Body`;
			const result = parseFrontmatter(content);
			expect(result.frontmatter.name).toBe("my-awesome-skill");
		});

		test("ignores unknown fields", () => {
			const content = `---
name: test
description: Test skill
license: MIT
allowed-tools: bash, read
metadata: some value
---

Body`;
			const result = parseFrontmatter(content);
			expect(result.frontmatter.name).toBe("test");
			expect(result.frontmatter.description).toBe("Test skill");
		});

		test("handles extra whitespace", () => {
			const content = `---
name:   spaced-name   
description:    Spaced description   
---

Body`;
			const result = parseFrontmatter(content);
			expect(result.frontmatter.name).toBe("spaced-name");
			expect(result.frontmatter.description).toBe("Spaced description");
		});
	});

	describe("missing or invalid frontmatter", () => {
		test("returns empty frontmatter when no opening delimiter", () => {
			const content = `name: test
description: No opening delimiter

Body`;
			const result = parseFrontmatter(content);
			expect(result.frontmatter.name).toBeUndefined();
			expect(result.frontmatter.description).toBe("");
			expect(result.body).toBe(content);
		});

		test("returns empty frontmatter when no closing delimiter", () => {
			const content = `---
name: test
description: No closing delimiter

Body content here`;
			const result = parseFrontmatter(content);
			expect(result.frontmatter.name).toBeUndefined();
			expect(result.frontmatter.description).toBe("");
			expect(result.body).toBe(content);
		});

		test("returns empty description when description field missing", () => {
			const content = `---
name: no-description
---

Body`;
			const result = parseFrontmatter(content);
			expect(result.frontmatter.name).toBe("no-description");
			expect(result.frontmatter.description).toBe("");
		});

		test("handles empty file", () => {
			const content = "";
			const result = parseFrontmatter(content);
			expect(result.frontmatter.name).toBeUndefined();
			expect(result.frontmatter.description).toBe("");
			expect(result.body).toBe("");
		});

		test("handles file with only frontmatter delimiters", () => {
			const content = `---
---`;
			const result = parseFrontmatter(content);
			expect(result.frontmatter.name).toBeUndefined();
			expect(result.frontmatter.description).toBe("");
		});
	});

	describe("line ending normalization", () => {
		test("handles Windows CRLF line endings", () => {
			const content = "---\r\nname: windows-skill\r\ndescription: Windows line endings\r\n---\r\n\r\nBody";
			const result = parseFrontmatter(content);
			expect(result.frontmatter.name).toBe("windows-skill");
			expect(result.frontmatter.description).toBe("Windows line endings");
			expect(result.body).toBe("Body");
		});

		test("handles old Mac CR line endings", () => {
			const content = "---\rname: mac-skill\rdescription: Mac line endings\r---\r\rBody";
			const result = parseFrontmatter(content);
			expect(result.frontmatter.name).toBe("mac-skill");
			expect(result.frontmatter.description).toBe("Mac line endings");
			expect(result.body).toBe("Body");
		});

		test("handles mixed line endings", () => {
			const content = "---\r\nname: mixed-skill\ndescription: Mixed endings\r---\n\nBody";
			const result = parseFrontmatter(content);
			expect(result.frontmatter.name).toBe("mixed-skill");
			expect(result.frontmatter.description).toBe("Mixed endings");
		});
	});

	describe("edge cases", () => {
		test("handles empty body", () => {
			const content = `---
name: no-body
description: Skill with no body
---`;
			const result = parseFrontmatter(content);
			expect(result.frontmatter.name).toBe("no-body");
			expect(result.frontmatter.description).toBe("Skill with no body");
			expect(result.body).toBe("");
		});

		test("handles body with --- in content", () => {
			const content = `---
name: test
description: Test
---

# Title

Some text with --- dashes in it

---

More content`;
			const result = parseFrontmatter(content);
			expect(result.frontmatter.name).toBe("test");
			expect(result.body).toContain("Some text with --- dashes in it");
			expect(result.body).toContain("More content");
		});

		test("handles very long description", () => {
			const longDesc = "A".repeat(1000);
			const content = `---
name: long
description: ${longDesc}
---

Body`;
			const result = parseFrontmatter(content);
			expect(result.frontmatter.description).toBe(longDesc);
		});

		test("handles unicode in name and description", () => {
			const content = `---
name: skill-日本語
description: Skill with émojis and ünïcödé 🚀
---

Body`;
			const result = parseFrontmatter(content);
			expect(result.frontmatter.name).toBe("skill-日本語");
			expect(result.frontmatter.description).toBe("Skill with émojis and ünïcödé 🚀");
		});

		test("handles name field without value", () => {
			const content = `---
name:
description: Has description but empty name
---

Body`;
			const result = parseFrontmatter(content);
			expect(result.frontmatter.name).toBe("");
			expect(result.frontmatter.description).toBe("Has description but empty name");
		});

		test("does not parse multiline YAML values", () => {
			const content = `---
name: test
description: |
  This is a multiline
  description block
---

Body`;
			const result = parseFrontmatter(content);
			expect(result.frontmatter.name).toBe("test");
			expect(result.frontmatter.description).toBe("|");
		});
	});
});

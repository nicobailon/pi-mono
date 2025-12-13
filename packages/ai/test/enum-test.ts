import { Type } from "@sinclair/typebox";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { StringEnum } from "../src/utils/typebox-helpers.js";

// Zod version
const zodSchema = z.object({
	operation: z.enum(["add", "subtract", "multiply", "divide"]),
});

// TypeBox with our StringEnum helper
const typeboxHelper = Type.Object({
	operation: StringEnum(["add", "subtract", "multiply", "divide"]),
});

// zod-to-json-schema's type surface can lag behind zod's types; cast for this debug script.
console.log("Zod:", JSON.stringify(zodToJsonSchema(zodSchema as unknown as z.ZodTypeAny), null, 2));
console.log("\nTypeBox.StringEnum:", JSON.stringify(typeboxHelper, null, 2));

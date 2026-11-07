// Build hai bản: dist/esm (import) và dist/cjs (require), kèm file .d.ts. Chỉ dùng tsc, không thêm công cụ bundle.
// Chạy: pnpm build (trong packages/sdk-js)
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
const run = (...args) => execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json", ...args], { cwd: root, stdio: "inherit" });

rmSync(join(root, "dist"), { recursive: true, force: true });
run();
run("--module", "CommonJS", "--moduleResolution", "Node10", "--verbatimModuleSyntax", "false", "--outDir", "dist/cjs");

// package.json gốc có "type": "module": thư mục cjs cần đánh dấu riêng để Node đọc .js là CommonJS
writeFileSync(join(root, "dist", "cjs", "package.json"), JSON.stringify({ type: "commonjs" }) + "\n");

// tsc đổi đuôi .ts thành .js trong file .js nhưng giữ nguyên trong file .d.ts: đổi tay để TypeScript cũ và công cụ khác đọc được
for (const dir of ["esm", "cjs"]) {
	for (const file of readdirSync(join(root, "dist", dir)).filter((f) => f.endsWith(".d.ts"))) {
		const path = join(root, "dist", dir, file);
		writeFileSync(path, readFileSync(path, "utf8").replace(/((?:from|import)\s*\(?\s*["']\.{1,2}\/[^"']+)\.ts(["'])/g, "$1.js$2"));
	}
}
console.log("Đã build dist/esm và dist/cjs");

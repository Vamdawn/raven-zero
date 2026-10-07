# 多包工程发布单一 ESM 输出

Raven Zero 使用 pnpm workspace 组织可嵌入模块与独立入口，以 TypeScript project references 和 `tsc -b` 编译，发布单一 ESM JavaScript 与类型声明。相比增加构建编排平台或维护 ESM/CommonJS 双输出，这符合首版 Node.js 24 范围并减少构建及消费验证组合；公开导出明确声明，CommonJS 宿主消费方式单独验证。

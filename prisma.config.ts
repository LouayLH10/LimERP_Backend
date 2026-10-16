import "dotenv/config";
import { defineConfig } from "prisma/config";
console.log(process.env.DATABASE_URL)
export default defineConfig({
  schema: "prisma/schema.prisma",
    migrations: {
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
})
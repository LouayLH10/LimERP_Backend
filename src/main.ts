import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { join } from "path";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
  );

  // Servir les images depuis le dossier uploads
  app.useStaticAssets(join(process.cwd(), "uploads"), {
    prefix: "/uploads/",
  });

  // Configuration CORS
  app.enableCors({
    origin: ["http://localhost:3000", "https://lim-erp.vercel.app/"],
    credentials: true,
  });

  await app.listen(3200);

  console.log("Backend running at http://localhost:3200");
  console.log("Employee images: http://localhost:3200/uploads/employees/");
}

bootstrap();

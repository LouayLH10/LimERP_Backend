
import 'dotenv/config';

import { PrismaClient } from '../src/generated/prisma/client';
import { UserRole } from '../src/generated/prisma/enums';
import { PrismaPg } from '@prisma/adapter-pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    'DATABASE_URL est absente. Vérifie le fichier .env à la racine du backend.',
  );
}

const adapter = new PrismaPg({
  connectionString,
});

const prisma = new PrismaClient({
  adapter,
});

async function main() {
  const superAdmin = await prisma.user.upsert({
    where: {
      email: 'samirhcine@hotmail.com',
    },
    update: {
      firstName: 'Samir',
      lastName: 'Hcine',
      phone: '28815988',
      role: UserRole.SUPER_ADMIN,
      isBlocked: false,
    },
    create: {
      firstName: 'Samir',
      lastName: 'Hcine',
      email: 'samirhcine@hotmail.com',
      phone: '28815988',
      role: UserRole.SUPER_ADMIN,
      isBlocked: false,
    },
  });

  console.log('Super Admin créé ou mis à jour :', superAdmin.email);
}

main()
  .catch((error: unknown) => {
    console.error('Erreur pendant le seed :', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

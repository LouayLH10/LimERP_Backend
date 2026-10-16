import { PrismaClient } from '../src/generated/prisma/client';
import { UserRole } from '../src/generated/prisma/enums';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
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

  console.log('Super Admin created:', superAdmin);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
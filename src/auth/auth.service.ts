import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomInt, createHash } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService} from 'src/email/email.service';

@Injectable()
export class AuthService {
  constructor(
  private readonly prisma: PrismaService,
  private readonly emailService: EmailService,
  private readonly jwtService: JwtService   ,
) {}

  /**
   * Generate and send an OTP to the user's phone.
   */
  async requestOtp(email: string) {
    const user = await this.prisma.user.findUnique({
      where: {
       email,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.isBlocked) {
      throw new UnauthorizedException('User account is blocked');
    }

    // Generate a 6-digit OTP
    const code = randomInt(100000, 1000000).toString();

    // Hash OTP before storing it
    const codeHash = this.hashOtp(code);

    // OTP valid for 5 minutes
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    // Invalidate previous unused OTPs
    await this.prisma.loginOtp.updateMany({
      where: {
        userId: user.id,
        usedAt: null,
      },
      data: {
        usedAt: new Date(),
      },
    });

    await this.prisma.loginOtp.create({
      data: {
        userId: user.id,
        codeHash,
        expiresAt,
      },
    });

    // Temporary development output
await this.emailService.sendOtp(user.email,user.firstName, code);
    return {
      message: 'OTP sent successfully',
      expiresAt,
    };
  }

  /**
   * Verify the OTP and create a session.
   */
async verifyOtp(email: string, code: string) { 
    console.log(process.env.JWT_SECRET)
    const user = await this.prisma.user.findUnique({ where: { email, }, });
     if (!user) { 
        throw new NotFoundException('User not found');
     } 
     if (user.isBlocked) {
         throw new UnauthorizedException( 'User account is blocked', ); 
        } 
        const otp = await this.prisma.loginOtp.findFirst({ 
            where: { userId: user.id, usedAt: null, }, 
            orderBy: { createdAt: 'desc', }, });
             if (!otp) { 
                throw new BadRequestException( 'No valid OTP found', );
             }
              if (otp.expiresAt < new Date()) {
                 throw new BadRequestException( 'OTP has expired', ); 
                } // Maximum number of attempts 
if (otp.attempts >= 5) {
     throw new UnauthorizedException( 'Too many attempts', ); 
    } 
    const codeHash = this.hashOtp(code); // Invalid OTP 
if (codeHash !== otp.codeHash) { 
    await this.prisma.loginOtp.update({ where: { id: otp.id, }, data: { attempts: { increment: 1, }, }, }); throw new UnauthorizedException( 'Invalid OTP', );
 } // Mark OTP as used 
await this.prisma.loginOtp.update({ where: { id: otp.id, }, data: { usedAt: new Date(), }, }); // Create session 
const session = await this.prisma.userSession.create({
     data: { userId: user.id, loginAt: new Date(), lastActivityAt: new Date(), }, 
    }); // JWT payload 
    const payload = { sub: user.id,
         email: user.email,
          role: user.role,
           sessionId: session.id,
         }; // Generate access token 
const accessToken = await this.jwtService.signAsync( payload, ); return { message: 'Login successful', access_token: accessToken, user: { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email, phone: user.phone, role: user.role, }, }; }

  /**
   * Logout the current session.
   */
  async logout(sessionId: string) {
    const session = await this.prisma.userSession.findUnique({
      where: {
        id: sessionId,
      },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    if (session.logoutAt) {
      throw new BadRequestException('Session already logged out');
    }

    await this.prisma.userSession.update({
      where: {
        id: sessionId,
      },
      data: {
        logoutAt: new Date(),
      },
    });

    return {
      message: 'Logout successful',
    };
  }

  /**
   * Hash an OTP before storing/comparing it.
   */
  private hashOtp(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }
}

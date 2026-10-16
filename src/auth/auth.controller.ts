import {
  Body,
  Controller,
  Post,
} from '@nestjs/common';

import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
  ) {}

  @Post('request-otp')
  requestOtp(@Body('email') email: string) {
    return this.authService.requestOtp(email);
  }

  @Post('verify-otp')
  verifyOtp(
    @Body('email') email: string,
    @Body('code') code: string,
  ) {
    return this.authService.verifyOtp(email, code);
  }

  @Post('logout')
  logout(@Body('sessionId') sessionId: string) {
    return this.authService.logout(sessionId);
  }
}

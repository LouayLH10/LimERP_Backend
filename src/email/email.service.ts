import {
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';

import emailjs from '@emailjs/nodejs';

@Injectable()
export class EmailService {
  private readonly publicKey = process.env.PUBLIC_KEY;
  private readonly privateKey = process.env.PRIVATE_KEY;
  private readonly serviceId = process.env.SERVICE_ID;
  private readonly templateId = process.env.TEMPLATE_ID;

  async sendOtp(
    email: string,
    name: string,
    code: string,
  ) {
    if (
      !this.publicKey ||
      !this.privateKey ||
      !this.serviceId ||
      !this.templateId
    ) {
      console.log(this.templateId)
      throw new InternalServerErrorException(
        'EmailJS configuration is missing',
      );
    }

    try {
      const response = await emailjs.send(
        this.serviceId,
        this.templateId,
        {
          to_email: email,
          name,
          email,
          otp_code: code,
          expires_in: '5 minutes',
        },
        {
          publicKey: this.publicKey,
          privateKey: this.privateKey,
        },
      );

      console.log('OTP email sent successfully:', response.status);

      return response;
    } catch (error) {
      console.error('EmailJS error:', error);

      throw new InternalServerErrorException(
        'Failed to send OTP email',
      );
    }
  }
}


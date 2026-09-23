import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { CurrentUser, Roles } from './auth.decorators';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import type { AuthenticatedUser } from './auth.types';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.me(user);
  }

  @Get('admin-test')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'ADMIN')
  adminTest(@CurrentUser() user: AuthenticatedUser) {
    return { message: 'Admin access granted', organizationId: user.organizationId };
  }
}

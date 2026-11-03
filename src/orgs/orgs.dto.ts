import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';
import { ROLES, type Role } from './roles';

const INVITE_ROLES = ['admin', 'member', 'viewer'] as const;

export class CreateOrganizationDto {
  @ApiProperty({ example: 'Acme Inc' })
  @IsString()
  @Length(1, 80)
  name!: string;
}

export class SwitchOrganizationDto {
  @ApiProperty()
  @IsUUID()
  organizationId!: string;
}

export class ChangeRoleDto {
  @ApiProperty({ enum: ROLES })
  @IsIn(ROLES)
  role!: Role;
}

export class CreateInviteDto {
  @ApiProperty()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ enum: INVITE_ROLES })
  @IsIn(INVITE_ROLES)
  role!: 'admin' | 'member' | 'viewer';
}

export class AcceptInviteDto {
  @ApiProperty()
  @IsString()
  @Length(10, 200)
  token!: string;
}

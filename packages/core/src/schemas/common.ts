import { z } from 'zod';

export const MEMBER_ID_PATTERN = /^m_[a-z2-7]{16}$/;
export const SQUAD_ID_PATTERN = /^sq_[a-z2-7]{16}$/;
export const SESSION_CODE_PATTERN = /^[A-Z]{2,6}[0-9]{2,4}[A-Z]?(-[A-Z]+[0-9]*)?$/;
export const CLOCK_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
export const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

export const memberIdSchema = z.string().regex(MEMBER_ID_PATTERN);
export const squadIdSchema = z.string().regex(SQUAD_ID_PATTERN);
export const sessionIdSchema = z.string().min(1).max(128);
export const sessionCodeSchema = z.string().regex(SESSION_CODE_PATTERN);
export const clockSchema = z.string().regex(CLOCK_PATTERN);
export const base64UrlSchema = z.string().regex(BASE64URL_PATTERN);
export const instantSchema = z.iso.datetime();

export type KnowledgeCategory =
  | 'precios'
  | 'horarios'
  | 'servicios'
  | 'faq'
  | 'ubicacion';

export type ChatRole = 'user' | 'assistant' | 'doctor';

export type PatientChatMode = 'AI_ACTIVE' | 'WAITING_HUMAN';

export interface BotSettings {
  id: number;
  bot_name: string;
  clinic_specialty: string | null;
  updated_at: string;
}

export interface Patient {
  phone: string;
  full_name: string | null;
  age: number | null;
  allergies_or_meds: string | null;
  onboarding_completed: boolean;
  chat_mode: PatientChatMode;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  patient_phone: string;
  role: ChatRole;
  content: string;
  created_at: string;
}

export interface KnowledgeItem {
  id: string;
  category: KnowledgeCategory;
  content: string;
  is_active: boolean;
  created_at: string;
}

export interface MatchedKnowledge {
  id: string;
  category: KnowledgeCategory;
  content: string;
  similarity: number;
}

export interface ClinicTask {
  id: number;
  description: string;
  is_completed: boolean;
  created_at: string;
}

export interface IncomingMessage {
  from: string;
  messageId: string;
  content: string;
  contextMessageId?: string;
}
export interface CalendarSlot {
  start: string;
  end: string;
  label: string;
}

export interface CalendarAppointment {
  eventId: string;
  summary: string;
  start: string;
  end: string;
  formattedTime: string;
  patientName: string;
  patientPhone: string | null;
  reason: string;
}

export interface CreateAppointmentInput {
  patientName: string;
  patientPhone: string;
  startTime: string; // ISO 8601 con zona horaria, ej. 2026-11-19T10:00:00-06:00
  endTime: string;   // ISO 8601 con zona horaria, ej. 2026-11-19T10:45:00-06:00
  reason: string;
  clinicalSummary: string;
  isUrgent: boolean;
}

export interface CancelledAppointmentInfo {
  eventId: string;
  patientName: string;
  patientPhone: string | null;
  appointmentDateText: string;
}
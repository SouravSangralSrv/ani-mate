
export enum Personality {
  MALE = 'MALE',
  FEMALE = 'FEMALE'
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface VoiceState {
  isActive: boolean;
  isThinking: boolean;
  isSpeaking: boolean;
  transcription: string;
}

export interface SystemAction {
  type: 'search' | 'youtube' | 'music' | 'browser';
  query: string;
}

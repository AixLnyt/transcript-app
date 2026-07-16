export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker: string | null;
}

export interface TranscribeResponse {
  session_id: string;
  status: string;
  media_type: "video" | "audio";
  media_url: string;
  segments: TranscriptSegment[];
}

export interface HistoryItem {
  session_id: string;
  original_name: string;
  media_type: "video" | "audio";
  created_at: string;
  segment_count: number;
  thumbnail_url: string | null;
}

export interface IncompleteItem {
  session_id: string;
  original_name: string;
  completed_seconds: number;
  total_seconds: number;
}
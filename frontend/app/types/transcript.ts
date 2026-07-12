export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscribeResponse {
  session_id: string;
  status: string;
  media_type: "video" | "audio";
  media_url: string;
  segments: TranscriptSegment[];
}

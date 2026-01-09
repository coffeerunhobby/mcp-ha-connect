export interface ServiceCallData {
  domain: string;
  service: string;
  service_data?: Record<string, unknown>;
  target?: {
    entity_id?: string | string[];
    device_id?: string | string[];
    area_id?: string | string[];
  };
}

export interface ServiceCallResponse {
  context: {
    id: string;
    parent_id: string | null;
    user_id: string | null;
  };
}

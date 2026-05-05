export interface HarvestTimeEntry {
  id: number;
  project: { id: number; name: string };
  task: { id: number; name: string };
  spent_date: string;
  hours: number;
  notes: string | null;
}

export interface CreateTimeEntryInput {
  project_id: number;
  task_id: number;
  spent_date: string; // YYYY-MM-DD
  hours: number;
  notes?: string;
}

export interface HarvestProject {
  id: number;
  name: string;
  code: string;
  is_active: boolean;
  client: { id: number; name: string } | null;
}

export interface HarvestClientOptions {
  token: string;
  accountId: string;
}

export class HarvestClient {
  private baseUrl = 'https://api.harvestapp.com/v2';
  private headers: Record<string, string>;

  constructor(private options: HarvestClientOptions) {
    this.headers = {
      Authorization: `Bearer ${options.token}`,
      'Harvest-Account-Id': options.accountId,
      'Content-Type': 'application/json',
      'User-Agent': 'Calendrome (calendrome MCP server)',
    };
  }

  async createTimeEntry(input: CreateTimeEntryInput): Promise<HarvestTimeEntry> {
    const res = await fetch(`${this.baseUrl}/time_entries`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Harvest create failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<HarvestTimeEntry>;
  }

  async updateTimeEntry(
    id: number,
    patch: { hours?: number; notes?: string },
  ): Promise<HarvestTimeEntry> {
    const res = await fetch(`${this.baseUrl}/time_entries/${id}`, {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Harvest update failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<HarvestTimeEntry>;
  }

  async listTimeEntries(from: string, to: string): Promise<HarvestTimeEntry[]> {
    const url = `${this.baseUrl}/time_entries?from=${from}&to=${to}&per_page=100`;
    const entries: HarvestTimeEntry[] = [];
    let page = url;
    while (page) {
      const res = await fetch(page, { headers: this.headers });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Harvest list failed (${res.status}): ${text}`);
      }
      const data = (await res.json()) as any;
      entries.push(...data.time_entries);
      page = data.links?.next ?? '';
    }
    return entries;
  }

  async listProjects(): Promise<HarvestProject[]> {
    const url = `${this.baseUrl}/projects?is_active=true&per_page=100`;
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Harvest projects failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as any;
    return data.projects;
  }
}

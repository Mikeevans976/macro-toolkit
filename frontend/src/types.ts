export interface Tool {
  id: string;
  name: string;
  icon: string;
  url: string;
  description?: string;
}

export interface Category {
  id: string;
  name: string;
  color: string;
  tools: Tool[];
}

export interface DashboardConfig {
  categories: Category[];
}

/**
 * Database Schema Types for Finasaan
 * Based on PostgreSQL schema with pgvector support
 */

// Enums
export type ReportPeriod = "Quarterly" | "Annual";
export type ReportType =
  | "Income_Statement"
  | "Balance_Sheet"
  | "Cash_Flow_Statement";

// Table Types
export interface Sector {
  id: number;
  name: string;
  description: string | null;
  parent_sector_id: number | null;
}

export interface FundProvider {
  id: number;
  name: string;
  description: string | null;
  logo_url: string | null;
  website_url: string | null;
}

export interface InsuranceProvider {
  id: number;
  name: string;
  description: string | null;
  logo_url: string | null;
}

export interface Company {
  id: number;
  symbol: string;
  company_name: string | null;
  description: string | null;
  sector_id: number | null;
  website_url: string | null;
  logo_url: string | null;
  founded_year: number | null;
  ceo_name: string | null;
  description_embedding: number[] | null; // pgvector
}

export interface MutualFund {
  id: number;
  symbol: string;
  name: string | null;
  provider_id: number | null;
  sector_id: number | null;
  description: string | null;
  inception_date: string | null; // DATE as ISO string
  fund_strategy_embedding: number[] | null; // pgvector
}

export interface UserPortfolio {
  id: number;
  user_id: number | null;
  name: string | null;
  description: string | null;
  created_at: string | null; // TIMESTAMPTZ as ISO string
}

export interface UserPortfolioHolding {
  id: number;
  portfolio_id: number | null;
  company_id: number | null;
  mutual_fund_id: number | null;
  quantity: number | null;
  average_purchase_price: number | null;
  added_at: string | null; // TIMESTAMPTZ as ISO string
}

export interface UserWatchlist {
  user_id: number;
  company_id: number;
  mutual_fund_id: number;
  notes: string | null;
  added_at: string | null; // TIMESTAMPTZ as ISO string
}

export interface MutualFundHolding {
  id: number;
  fund_id: number | null;
  company_id: number | null;
  as_of_date: string | null; // DATE as ISO string
  percentage_of_fund: number | null;
  shares_held: number | null;
}

export interface DailyStockData {
  id: number;
  company_id: number | null;
  trade_date: string | null; // DATE as ISO string
  open_price: number | null;
  high_price: number | null;
  low_price: number | null;
  close_price: number | null;
  adjusted_close_price: number | null;
  volume: number | null;
  value_traded: number | null;
}

export interface InsurancePolicy {
  id: number;
  provider_id: number | null;
  policy_name: string | null;
  sector_id: number | null;
  description: string | null;
  key_features: Record<string, unknown> | null; // JSONB
  policy_embedding: number[] | null; // pgvector
}

export interface CompanyAnnouncement {
  id: number;
  company_id: number | null;
  headline: string | null;
  body_text: string | null;
  source_url: string | null;
  publish_datetime: string | null; // TIMESTAMPTZ as ISO string
  announcement_embedding: number[] | null; // pgvector
}

export interface FinancialReport {
  id: number;
  company_id: number | null;
  report_type: ReportType | null;
  period_type: ReportPeriod | null;
  period_end_date: string | null; // DATE as ISO string
  fiscal_year: number | null;
  fiscal_quarter: number | null;
  currency: string | null;
  source_url: string | null;
  filed_date: string | null; // DATE as ISO string
  report_summary_embedding: number[] | null; // pgvector
}

export interface CompanyRatio {
  id: number;
  company_id: number | null;
  as_of_date: string | null; // DATE as ISO string
  ratio_key: string | null;
  ratio_value: number | null;
  ratio_period: string | null;
}

export interface MutualFundNavHistory {
  id: number;
  fund_id: number | null;
  nav_date: string | null; // DATE as ISO string
  nav_price: number | null;
}

export interface FinancialReportLineItem {
  id: number;
  report_id: number | null;
  item_key: string | null;
  item_label: string | null;
  item_value: number | null;
}

// Database interface for Supabase
export interface Database {
  public: {
    Tables: {
      sectors: {
        Row: Sector;
        Insert: Omit<Sector, "id"> & { id?: number };
        Update: Partial<Sector>;
      };
      fund_providers: {
        Row: FundProvider;
        Insert: Omit<FundProvider, "id"> & { id?: number };
        Update: Partial<FundProvider>;
      };
      insurance_providers: {
        Row: InsuranceProvider;
        Insert: Omit<InsuranceProvider, "id"> & { id?: number };
        Update: Partial<InsuranceProvider>;
      };
      companies: {
        Row: Company;
        Insert: Omit<Company, "id">;
        Update: Partial<Company>;
      };
      mutual_funds: {
        Row: MutualFund;
        Insert: Omit<MutualFund, "id">;
        Update: Partial<MutualFund>;
      };
      user_portfolios: {
        Row: UserPortfolio;
        Insert: Omit<UserPortfolio, "id">;
        Update: Partial<UserPortfolio>;
      };
      user_portfolio_holdings: {
        Row: UserPortfolioHolding;
        Insert: Omit<UserPortfolioHolding, "id"> & { id?: number };
        Update: Partial<UserPortfolioHolding>;
      };
      user_watchlists: {
        Row: UserWatchlist;
        Insert: UserWatchlist;
        Update: Partial<UserWatchlist>;
      };
      mutual_fund_holdings: {
        Row: MutualFundHolding;
        Insert: Omit<MutualFundHolding, "id"> & { id?: number };
        Update: Partial<MutualFundHolding>;
      };
      daily_stock_data: {
        Row: DailyStockData;
        Insert: Omit<DailyStockData, "id"> & { id?: number };
        Update: Partial<DailyStockData>;
      };
      insurance_policies: {
        Row: InsurancePolicy;
        Insert: Omit<InsurancePolicy, "id"> & { id?: number };
        Update: Partial<InsurancePolicy>;
      };
      company_announcements: {
        Row: CompanyAnnouncement;
        Insert: Omit<CompanyAnnouncement, "id"> & { id?: number };
        Update: Partial<CompanyAnnouncement>;
      };
      financial_reports: {
        Row: FinancialReport;
        Insert: Omit<FinancialReport, "id">;
        Update: Partial<FinancialReport>;
      };
      company_ratios: {
        Row: CompanyRatio;
        Insert: Omit<CompanyRatio, "id"> & { id?: number };
        Update: Partial<CompanyRatio>;
      };
      mutual_fund_nav_history: {
        Row: MutualFundNavHistory;
        Insert: Omit<MutualFundNavHistory, "id"> & { id?: number };
        Update: Partial<MutualFundNavHistory>;
      };
      financial_report_line_items: {
        Row: FinancialReportLineItem;
        Insert: Omit<FinancialReportLineItem, "id"> & { id?: number };
        Update: Partial<FinancialReportLineItem>;
      };
    };
  };
}

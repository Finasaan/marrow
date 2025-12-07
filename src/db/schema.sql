-- Finasaan Database Schema
-- PostgreSQL with pgvector extension for vector embeddings

-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Enums
CREATE TYPE report_period AS ENUM ('Quarterly', 'Annual');
CREATE TYPE report_type AS ENUM ('Income_Statement', 'Balance_Sheet', 'Cash_Flow_Statement');

-- Table: sectors
CREATE TABLE sectors (
    id SERIAL PRIMARY KEY,
    name VARCHAR(500) UNIQUE NOT NULL,
    description TEXT,
    parent_sector_id INT REFERENCES sectors(id)
);

-- Table: fund_providers
CREATE TABLE fund_providers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(500) UNIQUE NOT NULL,
    description TEXT,
    logo_url VARCHAR(500),
    website_url VARCHAR(500)
);

-- Table: insurance_providers
CREATE TABLE insurance_providers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(500) UNIQUE NOT NULL,
    description TEXT,
    logo_url VARCHAR(500)
);

-- Table: companies
CREATE TABLE companies (
    id BIGINT PRIMARY KEY,
    symbol VARCHAR(500) UNIQUE NOT NULL,
    company_name VARCHAR(500),
    description TEXT,
    sector_id INT REFERENCES sectors(id),
    website_url VARCHAR(500),
    logo_url VARCHAR(500),
    founded_year INT,
    ceo_name VARCHAR(500),
    description_embedding VECTOR
);

-- Table: mutual_funds
CREATE TABLE mutual_funds (
    id BIGINT PRIMARY KEY,
    symbol VARCHAR(500) UNIQUE NOT NULL,
    name VARCHAR(500),
    provider_id INT REFERENCES fund_providers(id),
    sector_id INT REFERENCES sectors(id),
    description TEXT,
    inception_date DATE,
    fund_strategy_embedding VECTOR
);

-- Table: user_portfolios
CREATE TABLE user_portfolios (
    id BIGINT PRIMARY KEY,
    user_id BIGINT,
    name VARCHAR(500),
    description TEXT,
    created_at TIMESTAMPTZ
);

-- Table: user_portfolio_holdings
CREATE TABLE user_portfolio_holdings (
    id BIGSERIAL PRIMARY KEY,
    portfolio_id BIGINT REFERENCES user_portfolios(id),
    company_id BIGINT REFERENCES companies(id),
    mutual_fund_id BIGINT REFERENCES mutual_funds(id),
    quantity DECIMAL,
    average_purchase_price DECIMAL,
    added_at TIMESTAMPTZ
);

-- Table: user_watchlists
CREATE TABLE user_watchlists (
    user_id BIGINT,
    company_id BIGINT REFERENCES companies(id),
    mutual_fund_id BIGINT REFERENCES mutual_funds(id),
    notes TEXT,
    added_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, company_id, mutual_fund_id)
);

-- Table: mutual_fund_holdings
CREATE TABLE mutual_fund_holdings (
    id BIGSERIAL PRIMARY KEY,
    fund_id BIGINT REFERENCES mutual_funds(id),
    company_id BIGINT REFERENCES companies(id),
    as_of_date DATE,
    percentage_of_fund DECIMAL,
    shares_held BIGINT
);

CREATE UNIQUE INDEX idx_mutual_fund_holdings_fund_id_company_id_as_of_date
    ON mutual_fund_holdings (fund_id, company_id, as_of_date);

-- Table: daily_stock_data
CREATE TABLE daily_stock_data (
    id BIGSERIAL PRIMARY KEY,
    company_id BIGINT REFERENCES companies(id),
    trade_date DATE,
    open_price DECIMAL,
    high_price DECIMAL,
    low_price DECIMAL,
    close_price DECIMAL,
    adjusted_close_price DECIMAL,
    volume BIGINT,
    value_traded DECIMAL
);

CREATE UNIQUE INDEX idx_daily_stock_data_company_id_trade_date
    ON daily_stock_data (company_id, trade_date);

-- Table: insurance_policies
CREATE TABLE insurance_policies (
    id BIGSERIAL PRIMARY KEY,
    provider_id INT REFERENCES insurance_providers(id),
    policy_name VARCHAR(500),
    sector_id INT REFERENCES sectors(id),
    description TEXT,
    key_features JSONB,
    policy_embedding VECTOR
);

-- Table: company_announcements
CREATE TABLE company_announcements (
    id BIGSERIAL PRIMARY KEY,
    company_id BIGINT REFERENCES companies(id),
    headline VARCHAR(500),
    body_text TEXT,
    source_url VARCHAR(500),
    publish_datetime TIMESTAMPTZ,
    announcement_embedding VECTOR
);

-- Table: financial_reports
CREATE TABLE financial_reports (
    id BIGINT PRIMARY KEY,
    company_id BIGINT REFERENCES companies(id),
    report_type report_type,
    period_type report_period,
    period_end_date DATE,
    fiscal_year INT,
    fiscal_quarter INT,
    currency VARCHAR(500),
    source_url TEXT,
    filed_date DATE,
    report_summary_embedding VECTOR
);

CREATE UNIQUE INDEX idx_financial_reports_company_id_report_type_period_end_date
    ON financial_reports (company_id, report_type, period_end_date);

-- Table: company_ratios
CREATE TABLE company_ratios (
    id BIGSERIAL PRIMARY KEY,
    company_id BIGINT REFERENCES companies(id),
    as_of_date DATE,
    ratio_key VARCHAR(500),
    ratio_value DECIMAL,
    ratio_period VARCHAR(500)
);

CREATE UNIQUE INDEX idx_company_ratios_company_id_as_of_date_ratio_key_ratio_period
    ON company_ratios (company_id, as_of_date, ratio_key, ratio_period);

-- Table: mutual_fund_nav_history
CREATE TABLE mutual_fund_nav_history (
    id BIGSERIAL PRIMARY KEY,
    fund_id BIGINT REFERENCES mutual_funds(id),
    nav_date DATE,
    nav_price DECIMAL
);

CREATE UNIQUE INDEX idx_mutual_fund_nav_history_fund_id_nav_date
    ON mutual_fund_nav_history (fund_id, nav_date);

-- Table: financial_report_line_items
CREATE TABLE financial_report_line_items (
    id BIGSERIAL PRIMARY KEY,
    report_id BIGINT REFERENCES financial_reports(id),
    item_key VARCHAR(500),
    item_label VARCHAR(500),
    item_value DECIMAL
);

CREATE UNIQUE INDEX idx_financial_report_line_items_report_id_item_key
    ON financial_report_line_items (report_id, item_key);

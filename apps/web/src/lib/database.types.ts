
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "ai_quota_usage": {
                  Row: {
                    "id": number,"limit_value": number | null,"period_kind": string,"period_start": string,"provider": string,"resource": string,"used": number
                  }
                  ComputedFields: never
                  Insert: {
                    "id"?: never,"limit_value"?: number | null,"period_kind": string,"period_start": string,"provider": string,"resource": string,"used"?: number
                  }
                  Update: {
                    "id"?: never,"limit_value"?: number | null,"period_kind"?: string,"period_start"?: string,"provider"?: string,"resource"?: string,"used"?: number
                  }
                  Relationships: [
                    
                  ]
                },"app_settings": {
                  Row: {
                    "created_at": string,"description": string | null,"is_public": boolean,"key": string,"updated_at": string,"updated_by": string | null,"value": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"description"?: string | null,"is_public"?: boolean,"key": string,"updated_at"?: string,"updated_by"?: string | null,"value": NonNullable<Json>
                  }
                  Update: {
                    "created_at"?: string,"description"?: string | null,"is_public"?: boolean,"key"?: string,"updated_at"?: string,"updated_by"?: string | null,"value"?: NonNullable<Json>
                  }
                  Relationships: [
                    
                  ]
                },"audit_events": {
                  Row: {
                    "action": string,"actor_id": string | null,"at": string,"details": NonNullable<Json>,"id": number,"target_id": string | null,"target_type": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor_id"?: string | null,"at"?: string,"details"?: NonNullable<Json>,"id"?: never,"target_id"?: string | null,"target_type"?: string | null
                  }
                  Update: {
                    "action"?: string,"actor_id"?: string | null,"at"?: string,"details"?: NonNullable<Json>,"id"?: never,"target_id"?: string | null,"target_type"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"broker_cash_transactions": {
                  Row: {
                    "amount": number,"category": string,"code": string | null,"conid": number | null,"currency": string,"dedupe_hash": string,"description": string | null,"fx_rate_to_base": number | null,"id": number,"isin": string | null,"occurred_at": string,"report_date": string | null,"symbol": string | null,"trade_id": string | null,"type_raw": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount": number,"category": string,"code"?: string | null,"conid"?: number | null,"currency": string,"dedupe_hash": string,"description"?: string | null,"fx_rate_to_base"?: number | null,"id"?: never,"isin"?: string | null,"occurred_at": string,"report_date"?: string | null,"symbol"?: string | null,"trade_id"?: string | null,"type_raw": string,"user_id": string
                  }
                  Update: {
                    "amount"?: number,"category"?: string,"code"?: string | null,"conid"?: number | null,"currency"?: string,"dedupe_hash"?: string,"description"?: string | null,"fx_rate_to_base"?: number | null,"id"?: never,"isin"?: string | null,"occurred_at"?: string,"report_date"?: string | null,"symbol"?: string | null,"trade_id"?: string | null,"type_raw"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"broker_closed_lots": {
                  Row: {
                    "close_date": string,"closing_trade_id": string | null,"conid": number,"cost_basis": number,"currency": string,"dedupe_hash": string,"fifo_pnl_realized": number,"fx_rate_to_base": number | null,"id": number,"open_date_time": string | null,"proceeds": number | null,"quantity": number,"symbol": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "close_date": string,"closing_trade_id"?: string | null,"conid": number,"cost_basis": number,"currency": string,"dedupe_hash": string,"fifo_pnl_realized": number,"fx_rate_to_base"?: number | null,"id"?: never,"open_date_time"?: string | null,"proceeds"?: number | null,"quantity": number,"symbol": string,"user_id": string
                  }
                  Update: {
                    "close_date"?: string,"closing_trade_id"?: string | null,"conid"?: number,"cost_basis"?: number,"currency"?: string,"dedupe_hash"?: string,"fifo_pnl_realized"?: number,"fx_rate_to_base"?: number | null,"id"?: never,"open_date_time"?: string | null,"proceeds"?: number | null,"quantity"?: number,"symbol"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"broker_connections": {
                  Row: {
                    "account_id_masked": string | null,"account_type": string | null,"base_currency": string | null,"coverage_from": string | null,"created_at": string,"flex_token_ciphertext": string | null,"flex_token_iv": string | null,"id": string,"key_version": number | null,"last_error_at": string | null,"last_error_code": number | null,"last_error_message": string | null,"last_flex_call_at": string | null,"last_manual_refresh_at": string | null,"last_statement_date": string | null,"last_sync_at": string | null,"last_verified_at": string | null,"linked_at": string | null,"next_flex_fetch_not_before": string | null,"query_id": string | null,"status": Database["public"]['Enums']["broker_status"],"token_expires_on": string | null,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_id_masked"?: string | null,"account_type"?: string | null,"base_currency"?: string | null,"coverage_from"?: string | null,"created_at"?: string,"flex_token_ciphertext"?: string | null,"flex_token_iv"?: string | null,"id"?: string,"key_version"?: number | null,"last_error_at"?: string | null,"last_error_code"?: number | null,"last_error_message"?: string | null,"last_flex_call_at"?: string | null,"last_manual_refresh_at"?: string | null,"last_statement_date"?: string | null,"last_sync_at"?: string | null,"last_verified_at"?: string | null,"linked_at"?: string | null,"next_flex_fetch_not_before"?: string | null,"query_id"?: string | null,"status"?: Database["public"]['Enums']["broker_status"],"token_expires_on"?: string | null,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "account_id_masked"?: string | null,"account_type"?: string | null,"base_currency"?: string | null,"coverage_from"?: string | null,"created_at"?: string,"flex_token_ciphertext"?: string | null,"flex_token_iv"?: string | null,"id"?: string,"key_version"?: number | null,"last_error_at"?: string | null,"last_error_code"?: number | null,"last_error_message"?: string | null,"last_flex_call_at"?: string | null,"last_manual_refresh_at"?: string | null,"last_statement_date"?: string | null,"last_sync_at"?: string | null,"last_verified_at"?: string | null,"linked_at"?: string | null,"next_flex_fetch_not_before"?: string | null,"query_id"?: string | null,"status"?: Database["public"]['Enums']["broker_status"],"token_expires_on"?: string | null,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"broker_corporate_actions": {
                  Row: {
                    "amount": number | null,"code": string | null,"conid": number | null,"currency": string | null,"dedupe_hash": string,"id": number,"kind": string,"occurred_at": string | null,"quantity": number | null,"symbol": string | null,"type_raw": string | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount"?: number | null,"code"?: string | null,"conid"?: number | null,"currency"?: string | null,"dedupe_hash": string,"id"?: never,"kind": string,"occurred_at"?: string | null,"quantity"?: number | null,"symbol"?: string | null,"type_raw"?: string | null,"user_id": string
                  }
                  Update: {
                    "amount"?: number | null,"code"?: string | null,"conid"?: number | null,"currency"?: string | null,"dedupe_hash"?: string,"id"?: never,"kind"?: string,"occurred_at"?: string | null,"quantity"?: number | null,"symbol"?: string | null,"type_raw"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"broker_fx_rates": {
                  Row: {
                    "from_ccy": string,"id": number,"rate": number,"rate_date": string,"to_ccy": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "from_ccy": string,"id"?: never,"rate": number,"rate_date": string,"to_ccy": string,"user_id": string
                  }
                  Update: {
                    "from_ccy"?: string,"id"?: never,"rate"?: number,"rate_date"?: string,"to_ccy"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"broker_nav": {
                  Row: {
                    "cash": number | null,"currency": string,"id": number,"other": number | null,"report_date": string,"stock": number | null,"total": number,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "cash"?: number | null,"currency": string,"id"?: never,"other"?: number | null,"report_date": string,"stock"?: number | null,"total": number,"user_id": string
                  }
                  Update: {
                    "cash"?: number | null,"currency"?: string,"id"?: never,"other"?: number | null,"report_date"?: string,"stock"?: number | null,"total"?: number,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"broker_positions": {
                  Row: {
                    "asset_class": string | null,"conid": number,"cost_basis_money": number | null,"cost_basis_price": number | null,"currency": string,"description": string | null,"fifo_pnl_unrealized": number | null,"fx_rate_to_base": number | null,"id": number,"isin": string | null,"level_of_detail": string,"listing_exchange": string | null,"mark_price": number | null,"match_status": string,"multiplier": number,"open_date_time": string | null,"open_price": number | null,"percent_of_nav": number | null,"position_value": number | null,"quantity": number,"report_date": string,"security_id": string | null,"signal_security_id": string | null,"sub_category": string | null,"symbol": string,"user_id": string,"valuation_reason": string | null,"valuation_revalued_at": string | null,"valuation_session_date": string | null,"valuation_tag": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "asset_class"?: string | null,"conid": number,"cost_basis_money"?: number | null,"cost_basis_price"?: number | null,"currency": string,"description"?: string | null,"fifo_pnl_unrealized"?: number | null,"fx_rate_to_base"?: number | null,"id"?: never,"isin"?: string | null,"level_of_detail"?: string,"listing_exchange"?: string | null,"mark_price"?: number | null,"match_status"?: string,"multiplier"?: number,"open_date_time"?: string | null,"open_price"?: number | null,"percent_of_nav"?: number | null,"position_value"?: number | null,"quantity": number,"report_date": string,"security_id"?: string | null,"signal_security_id"?: string | null,"sub_category"?: string | null,"symbol": string,"user_id": string,"valuation_reason"?: string | null,"valuation_revalued_at"?: string | null,"valuation_session_date"?: string | null,"valuation_tag"?: string | null
                  }
                  Update: {
                    "asset_class"?: string | null,"conid"?: number,"cost_basis_money"?: number | null,"cost_basis_price"?: number | null,"currency"?: string,"description"?: string | null,"fifo_pnl_unrealized"?: number | null,"fx_rate_to_base"?: number | null,"id"?: never,"isin"?: string | null,"level_of_detail"?: string,"listing_exchange"?: string | null,"mark_price"?: number | null,"match_status"?: string,"multiplier"?: number,"open_date_time"?: string | null,"open_price"?: number | null,"percent_of_nav"?: number | null,"position_value"?: number | null,"quantity"?: number,"report_date"?: string,"security_id"?: string | null,"signal_security_id"?: string | null,"sub_category"?: string | null,"symbol"?: string,"user_id"?: string,"valuation_reason"?: string | null,"valuation_revalued_at"?: string | null,"valuation_session_date"?: string | null,"valuation_tag"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "broker_positions_security_id_fkey"
      columns: ["security_id"]
isOneToOne: false
      referencedRelation: "securities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "broker_positions_security_id_fkey"
      columns: ["security_id"]
isOneToOne: false
      referencedRelation: "v_todays_discounts"
      referencedColumns: ["security_id"]
    },{
      foreignKeyName: "broker_positions_signal_security_id_fkey"
      columns: ["signal_security_id"]
isOneToOne: false
      referencedRelation: "securities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "broker_positions_signal_security_id_fkey"
      columns: ["signal_security_id"]
isOneToOne: false
      referencedRelation: "v_todays_discounts"
      referencedColumns: ["security_id"]
    }
                  ]
                },"broker_sync_runs": {
                  Row: {
                    "connection_id": string,"created_at": string,"error_code": number | null,"error_message": string | null,"finished_at": string | null,"id": string,"idempotency_key": string,"kind": string,"last_poll_at": string | null,"lease_until": string | null,"next_poll_at": string | null,"poll_count": number,"reference_code": string | null,"requested_at": string | null,"rows_summary": NonNullable<Json>,"state": Database["public"]['Enums']["sync_state"],"statement_from": string | null,"statement_to": string | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "connection_id": string,"created_at"?: string,"error_code"?: number | null,"error_message"?: string | null,"finished_at"?: string | null,"id"?: string,"idempotency_key": string,"kind": string,"last_poll_at"?: string | null,"lease_until"?: string | null,"next_poll_at"?: string | null,"poll_count"?: number,"reference_code"?: string | null,"requested_at"?: string | null,"rows_summary"?: NonNullable<Json>,"state"?: Database["public"]['Enums']["sync_state"],"statement_from"?: string | null,"statement_to"?: string | null,"user_id": string
                  }
                  Update: {
                    "connection_id"?: string,"created_at"?: string,"error_code"?: number | null,"error_message"?: string | null,"finished_at"?: string | null,"id"?: string,"idempotency_key"?: string,"kind"?: string,"last_poll_at"?: string | null,"lease_until"?: string | null,"next_poll_at"?: string | null,"poll_count"?: number,"reference_code"?: string | null,"requested_at"?: string | null,"rows_summary"?: NonNullable<Json>,"state"?: Database["public"]['Enums']["sync_state"],"statement_from"?: string | null,"statement_to"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "broker_sync_runs_connection_id_fkey"
      columns: ["connection_id"]
isOneToOne: false
      referencedRelation: "broker_connections"
      referencedColumns: ["id"]
    }
                  ]
                },"broker_trades": {
                  Row: {
                    "buy_sell": string,"conid": number,"cost_basis": number | null,"currency": string,"description": string | null,"exchange": string | null,"fifo_pnl_realized": number | null,"fx_rate_to_base": number | null,"ib_commission": number | null,"ib_commission_currency": string | null,"ib_exec_id": string,"ib_order_id": string | null,"id": number,"isin": string | null,"listing_exchange": string | null,"net_cash": number | null,"open_close": string | null,"order_type": string | null,"proceeds": number | null,"quantity": number,"report_date": string | null,"settle_date": string | null,"symbol": string,"taxes": number | null,"trade_date": string,"trade_id": string | null,"trade_money": number | null,"trade_price": number,"trade_time": string | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "buy_sell": string,"conid": number,"cost_basis"?: number | null,"currency": string,"description"?: string | null,"exchange"?: string | null,"fifo_pnl_realized"?: number | null,"fx_rate_to_base"?: number | null,"ib_commission"?: number | null,"ib_commission_currency"?: string | null,"ib_exec_id": string,"ib_order_id"?: string | null,"id"?: never,"isin"?: string | null,"listing_exchange"?: string | null,"net_cash"?: number | null,"open_close"?: string | null,"order_type"?: string | null,"proceeds"?: number | null,"quantity": number,"report_date"?: string | null,"settle_date"?: string | null,"symbol": string,"taxes"?: number | null,"trade_date": string,"trade_id"?: string | null,"trade_money"?: number | null,"trade_price": number,"trade_time"?: string | null,"user_id": string
                  }
                  Update: {
                    "buy_sell"?: string,"conid"?: number,"cost_basis"?: number | null,"currency"?: string,"description"?: string | null,"exchange"?: string | null,"fifo_pnl_realized"?: number | null,"fx_rate_to_base"?: number | null,"ib_commission"?: number | null,"ib_commission_currency"?: string | null,"ib_exec_id"?: string,"ib_order_id"?: string | null,"id"?: never,"isin"?: string | null,"listing_exchange"?: string | null,"net_cash"?: number | null,"open_close"?: string | null,"order_type"?: string | null,"proceeds"?: number | null,"quantity"?: number,"report_date"?: string | null,"settle_date"?: string | null,"symbol"?: string,"taxes"?: number | null,"trade_date"?: string,"trade_id"?: string | null,"trade_money"?: number | null,"trade_price"?: number,"trade_time"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"companies": {
                  Row: {
                    "canonical_security_id": string | null,"country": string | null,"created_at": string,"exclusion_reason": string | null,"id": string,"identity_note": string | null,"industry": string | null,"ir_rss_urls": (string)[],"name": string,"name_normalized": string,"news_symbol": string | null,"profile_refreshed_at": string | null,"sec_cik": string | null,"sector": string | null,"status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "canonical_security_id"?: string | null,"country"?: string | null,"created_at"?: string,"exclusion_reason"?: string | null,"id"?: string,"identity_note"?: string | null,"industry"?: string | null,"ir_rss_urls"?: (string)[],"name": string,"name_normalized": string,"news_symbol"?: string | null,"profile_refreshed_at"?: string | null,"sec_cik"?: string | null,"sector"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "canonical_security_id"?: string | null,"country"?: string | null,"created_at"?: string,"exclusion_reason"?: string | null,"id"?: string,"identity_note"?: string | null,"industry"?: string | null,"ir_rss_urls"?: (string)[],"name"?: string,"name_normalized"?: string,"news_symbol"?: string | null,"profile_refreshed_at"?: string | null,"sec_cik"?: string | null,"sector"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "companies_canonical_fk"
      columns: ["canonical_security_id"]
isOneToOne: false
      referencedRelation: "securities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "companies_canonical_fk"
      columns: ["canonical_security_id"]
isOneToOne: false
      referencedRelation: "v_todays_discounts"
      referencedColumns: ["security_id"]
    }
                  ]
                },"digest_deliveries": {
                  Row: {
                    "attempt_log": NonNullable<Json>,"attempts": number,"channel": Database["public"]['Enums']["delivery_channel"],"delivered_at": string | null,"digest_id": string,"id": string,"idempotency_key": string,"last_error": string | null,"next_attempt_at": string,"provider_message_id": string | null,"quota_consumed": boolean,"sent_at": string | null,"skip_reason": string | null,"status": Database["public"]['Enums']["delivery_status"],"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempt_log"?: NonNullable<Json>,"attempts"?: number,"channel": Database["public"]['Enums']["delivery_channel"],"delivered_at"?: string | null,"digest_id": string,"id"?: string,"idempotency_key": string,"last_error"?: string | null,"next_attempt_at"?: string,"provider_message_id"?: string | null,"quota_consumed"?: boolean,"sent_at"?: string | null,"skip_reason"?: string | null,"status"?: Database["public"]['Enums']["delivery_status"],"user_id": string
                  }
                  Update: {
                    "attempt_log"?: NonNullable<Json>,"attempts"?: number,"channel"?: Database["public"]['Enums']["delivery_channel"],"delivered_at"?: string | null,"digest_id"?: string,"id"?: string,"idempotency_key"?: string,"last_error"?: string | null,"next_attempt_at"?: string,"provider_message_id"?: string | null,"quota_consumed"?: boolean,"sent_at"?: string | null,"skip_reason"?: string | null,"status"?: Database["public"]['Enums']["delivery_status"],"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "digest_deliveries_digest_id_fkey"
      columns: ["digest_id"]
isOneToOne: false
      referencedRelation: "digests"
      referencedColumns: ["id"]
    }
                  ]
                },"digest_items": {
                  Row: {
                    "created_at": string,"digest_id": string,"id": number,"payload": NonNullable<Json>,"ref_id": string,"ref_type": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"digest_id": string,"id"?: never,"payload"?: NonNullable<Json>,"ref_id": string,"ref_type": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"digest_id"?: string,"id"?: never,"payload"?: NonNullable<Json>,"ref_id"?: string,"ref_type"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "digest_items_digest_id_fkey"
      columns: ["digest_id"]
isOneToOne: false
      referencedRelation: "digests"
      referencedColumns: ["id"]
    }
                  ]
                },"digests": {
                  Row: {
                    "content": NonNullable<Json>,"content_hash": string,"created_at": string,"cutoff_reason": string,"id": string,"kind": Database["public"]['Enums']["digest_kind"],"scan_run_id": string,"skip_reason": string | null,"status": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "content"?: NonNullable<Json>,"content_hash": string,"created_at"?: string,"cutoff_reason": string,"id"?: string,"kind": Database["public"]['Enums']["digest_kind"],"scan_run_id": string,"skip_reason"?: string | null,"status"?: string,"user_id": string
                  }
                  Update: {
                    "content"?: NonNullable<Json>,"content_hash"?: string,"created_at"?: string,"cutoff_reason"?: string,"id"?: string,"kind"?: Database["public"]['Enums']["digest_kind"],"scan_run_id"?: string,"skip_reason"?: string | null,"status"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "digests_scan_run_id_fkey"
      columns: ["scan_run_id"]
isOneToOne: false
      referencedRelation: "scan_runs"
      referencedColumns: ["id"]
    }
                  ]
                },"email_events": {
                  Row: {
                    "delivery_id": string | null,"email_id": string | null,"id": number,"payload": Json | null,"received_at": string,"recipient_hash": string | null,"svix_id": string,"type": string
                  }
                  ComputedFields: never
                  Insert: {
                    "delivery_id"?: string | null,"email_id"?: string | null,"id"?: never,"payload"?: Json | null,"received_at"?: string,"recipient_hash"?: string | null,"svix_id": string,"type": string
                  }
                  Update: {
                    "delivery_id"?: string | null,"email_id"?: string | null,"id"?: never,"payload"?: Json | null,"received_at"?: string,"recipient_hash"?: string | null,"svix_id"?: string,"type"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "email_events_delivery_id_fkey"
      columns: ["delivery_id"]
isOneToOne: false
      referencedRelation: "digest_deliveries"
      referencedColumns: ["id"]
    }
                  ]
                },"eur_equivalent_overrides": {
                  Row: {
                    "action": string,"active": boolean,"created_at": string,"created_by": string | null,"eur_symbol_yahoo": string | null,"ibkr_conid": number | null,"ibkr_exchange_id": string,"ibkr_local_symbol": string | null,"id": string,"isin": string | null,"reason": string,"security_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"active"?: boolean,"created_at"?: string,"created_by"?: string | null,"eur_symbol_yahoo"?: string | null,"ibkr_conid"?: number | null,"ibkr_exchange_id": string,"ibkr_local_symbol"?: string | null,"id"?: string,"isin"?: string | null,"reason": string,"security_id": string,"updated_at"?: string
                  }
                  Update: {
                    "action"?: string,"active"?: boolean,"created_at"?: string,"created_by"?: string | null,"eur_symbol_yahoo"?: string | null,"ibkr_conid"?: number | null,"ibkr_exchange_id"?: string,"ibkr_local_symbol"?: string | null,"id"?: string,"isin"?: string | null,"reason"?: string,"security_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "eur_equivalent_overrides_security_id_fkey"
      columns: ["security_id"]
isOneToOne: false
      referencedRelation: "securities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "eur_equivalent_overrides_security_id_fkey"
      columns: ["security_id"]
isOneToOne: false
      referencedRelation: "v_todays_discounts"
      referencedColumns: ["security_id"]
    }
                  ]
                },"eur_equivalents": {
                  Row: {
                    "created_at": string,"currency": string,"eur_symbol_yahoo": string | null,"ibkr_conid": number | null,"ibkr_exchange_id": string,"ibkr_local_symbol": string | null,"id": string,"isin": string | null,"security_id": string,"status": Database["public"]['Enums']["eur_status"],"updated_at": string,"verification": NonNullable<Json>,"verified_at": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"currency"?: string,"eur_symbol_yahoo"?: string | null,"ibkr_conid"?: number | null,"ibkr_exchange_id": string,"ibkr_local_symbol"?: string | null,"id"?: string,"isin"?: string | null,"security_id": string,"status": Database["public"]['Enums']["eur_status"],"updated_at"?: string,"verification"?: NonNullable<Json>,"verified_at"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"currency"?: string,"eur_symbol_yahoo"?: string | null,"ibkr_conid"?: number | null,"ibkr_exchange_id"?: string,"ibkr_local_symbol"?: string | null,"id"?: string,"isin"?: string | null,"security_id"?: string,"status"?: Database["public"]['Enums']["eur_status"],"updated_at"?: string,"verification"?: NonNullable<Json>,"verified_at"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "eur_equivalents_security_id_fkey"
      columns: ["security_id"]
isOneToOne: false
      referencedRelation: "securities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "eur_equivalents_security_id_fkey"
      columns: ["security_id"]
isOneToOne: false
      referencedRelation: "v_todays_discounts"
      referencedColumns: ["security_id"]
    }
                  ]
                },"exchanges": {
                  Row: {
                    "code": string,"country": string,"created_at": string,"currencies": (string)[],"ibkr_exchange_id": string | null,"max_gap_days": number,"mic": string | null,"name": string,"screener_enabled": boolean,"session_close_local": string | null,"timezone": string,"trading_days": (number)[],"tradingview_prefix": string | null,"tradingview_verified": boolean,"us_primary": boolean,"venue_class": Database["public"]['Enums']["venue_class"],"yahoo_suffix": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "code": string,"country": string,"created_at"?: string,"currencies": (string)[],"ibkr_exchange_id"?: string | null,"max_gap_days"?: number,"mic"?: string | null,"name": string,"screener_enabled"?: boolean,"session_close_local"?: string | null,"timezone": string,"trading_days"?: (number)[],"tradingview_prefix"?: string | null,"tradingview_verified"?: boolean,"us_primary"?: boolean,"venue_class"?: Database["public"]['Enums']["venue_class"],"yahoo_suffix"?: string | null
                  }
                  Update: {
                    "code"?: string,"country"?: string,"created_at"?: string,"currencies"?: (string)[],"ibkr_exchange_id"?: string | null,"max_gap_days"?: number,"mic"?: string | null,"name"?: string,"screener_enabled"?: boolean,"session_close_local"?: string | null,"timezone"?: string,"trading_days"?: (number)[],"tradingview_prefix"?: string | null,"tradingview_verified"?: boolean,"us_primary"?: boolean,"venue_class"?: Database["public"]['Enums']["venue_class"],"yahoo_suffix"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"fx_rates": {
                  Row: {
                    "ccy": string,"id": number,"rate_date": string,"retrieved_at": string,"source": string,"source_symbol": string | null,"usd_per_unit": number
                  }
                  ComputedFields: never
                  Insert: {
                    "ccy": string,"id"?: never,"rate_date": string,"retrieved_at"?: string,"source": string,"source_symbol"?: string | null,"usd_per_unit": number
                  }
                  Update: {
                    "ccy"?: string,"id"?: never,"rate_date"?: string,"retrieved_at"?: string,"source"?: string,"source_symbol"?: string | null,"usd_per_unit"?: number
                  }
                  Relationships: [
                    
                  ]
                },"ibkr_catalogue": {
                  Row: {
                    "conid": number,"currency": string,"description": string | null,"exchange_id": string,"fetched_at": string,"isin": string | null,"local_symbol": string,"product_type": string,"symbol": string
                  }
                  ComputedFields: never
                  Insert: {
                    "conid": number,"currency": string,"description"?: string | null,"exchange_id": string,"fetched_at"?: string,"isin"?: string | null,"local_symbol": string,"product_type": string,"symbol": string
                  }
                  Update: {
                    "conid"?: number,"currency"?: string,"description"?: string | null,"exchange_id"?: string,"fetched_at"?: string,"isin"?: string | null,"local_symbol"?: string,"product_type"?: string,"symbol"?: string
                  }
                  Relationships: [
                    
                  ]
                },"llm_model_state": {
                  Row: {
                    "exhausted_until": string | null,"last_error": string | null,"model_key": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "exhausted_until"?: string | null,"last_error"?: string | null,"model_key": string,"updated_at"?: string
                  }
                  Update: {
                    "exhausted_until"?: string | null,"last_error"?: string | null,"model_key"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"market_cap_snapshots": {
                  Row: {
                    "currency_major": string,"fx_rate_date": string | null,"fx_source": string | null,"fx_usd_per_unit": number | null,"id": number,"market_cap_native": number | null,"market_cap_usd": number | null,"price_time": string | null,"quality": string,"scan_run_id": string,"security_id": string,"shares_outstanding": number | null,"source": string
                  }
                  ComputedFields: never
                  Insert: {
                    "currency_major": string,"fx_rate_date"?: string | null,"fx_source"?: string | null,"fx_usd_per_unit"?: number | null,"id"?: never,"market_cap_native"?: number | null,"market_cap_usd"?: number | null,"price_time"?: string | null,"quality": string,"scan_run_id": string,"security_id": string,"shares_outstanding"?: number | null,"source": string
                  }
                  Update: {
                    "currency_major"?: string,"fx_rate_date"?: string | null,"fx_source"?: string | null,"fx_usd_per_unit"?: number | null,"id"?: never,"market_cap_native"?: number | null,"market_cap_usd"?: number | null,"price_time"?: string | null,"quality"?: string,"scan_run_id"?: string,"security_id"?: string,"shares_outstanding"?: number | null,"source"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "market_cap_snapshots_run_fk"
      columns: ["scan_run_id"]
isOneToOne: false
      referencedRelation: "scan_runs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "market_cap_snapshots_security_id_fkey"
      columns: ["security_id"]
isOneToOne: false
      referencedRelation: "securities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "market_cap_snapshots_security_id_fkey"
      columns: ["security_id"]
isOneToOne: false
      referencedRelation: "v_todays_discounts"
      referencedColumns: ["security_id"]
    }
                  ]
                },"notification_preferences": {
                  Row: {
                    "digest_country_filter": string | null,"digest_modes": (Database["public"]['Enums']["universe_mode"])[],"email_bounced_at": string | null,"email_enabled": boolean,"email_unsubscribed_at": string | null,"push_enabled": boolean,"send_empty": boolean,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "digest_country_filter"?: string | null,"digest_modes"?: (Database["public"]['Enums']["universe_mode"])[],"email_bounced_at"?: string | null,"email_enabled"?: boolean,"email_unsubscribed_at"?: string | null,"push_enabled"?: boolean,"send_empty"?: boolean,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "digest_country_filter"?: string | null,"digest_modes"?: (Database["public"]['Enums']["universe_mode"])[],"email_bounced_at"?: string | null,"email_enabled"?: boolean,"email_unsubscribed_at"?: string | null,"push_enabled"?: boolean,"send_empty"?: boolean,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"price_series": {
                  Row: {
                    "adjustment_policy": string,"bar_count": number,"bar_dates": (number)[],"close": (number)[],"completeness": NonNullable<Json>,"first_bar_date": string,"freshness": Database["public"]['Enums']["freshness_status"],"high": (number)[],"last_bar_date": string,"last_close": number,"last_full_refresh_at": string,"last_session_date": string,"low": (number)[],"open": (number)[],"prev_close": number | null,"provider": string,"retrieved_at": string,"security_id": string,"updated_at": string,"volume": (number)[]
                  }
                  ComputedFields: never
                  Insert: {
                    "adjustment_policy"?: string,"bar_count": number,"bar_dates": (number)[],"close": (number)[],"completeness"?: NonNullable<Json>,"first_bar_date": string,"freshness"?: Database["public"]['Enums']["freshness_status"],"high": (number)[],"last_bar_date": string,"last_close": number,"last_full_refresh_at": string,"last_session_date": string,"low": (number)[],"open": (number)[],"prev_close"?: number | null,"provider"?: string,"retrieved_at": string,"security_id": string,"updated_at"?: string,"volume": (number)[]
                  }
                  Update: {
                    "adjustment_policy"?: string,"bar_count"?: number,"bar_dates"?: (number)[],"close"?: (number)[],"completeness"?: NonNullable<Json>,"first_bar_date"?: string,"freshness"?: Database["public"]['Enums']["freshness_status"],"high"?: (number)[],"last_bar_date"?: string,"last_close"?: number,"last_full_refresh_at"?: string,"last_session_date"?: string,"low"?: (number)[],"open"?: (number)[],"prev_close"?: number | null,"provider"?: string,"retrieved_at"?: string,"security_id"?: string,"updated_at"?: string,"volume"?: (number)[]
                  }
                  Relationships: [
                    {
      foreignKeyName: "price_series_security_id_fkey"
      columns: ["security_id"]
isOneToOne: true
      referencedRelation: "securities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "price_series_security_id_fkey"
      columns: ["security_id"]
isOneToOne: true
      referencedRelation: "v_todays_discounts"
      referencedColumns: ["security_id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "created_at": string,"default_destination": string,"display_name": string | null,"is_admin": boolean,"timezone": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"default_destination"?: string,"display_name"?: string | null,"is_admin"?: boolean,"timezone"?: string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"default_destination"?: string,"display_name"?: string | null,"is_admin"?: boolean,"timezone"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"push_subscriptions": {
                  Row: {
                    "auth": string,"created_at": string,"endpoint": string,"failure_count": number,"id": string,"last_failure_at": string | null,"last_success_at": string | null,"last_test_at": string | null,"p256dh": string,"revoke_reason": string | null,"revoked_at": string | null,"user_agent": string | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "auth": string,"created_at"?: string,"endpoint": string,"failure_count"?: number,"id"?: string,"last_failure_at"?: string | null,"last_success_at"?: string | null,"last_test_at"?: string | null,"p256dh": string,"revoke_reason"?: string | null,"revoked_at"?: string | null,"user_agent"?: string | null,"user_id": string
                  }
                  Update: {
                    "auth"?: string,"created_at"?: string,"endpoint"?: string,"failure_count"?: number,"id"?: string,"last_failure_at"?: string | null,"last_success_at"?: string | null,"last_test_at"?: string | null,"p256dh"?: string,"revoke_reason"?: string | null,"revoked_at"?: string | null,"user_agent"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"quote_cache": {
                  Row: {
                    "expires_at": string,"fetched_at": string,"hit_count": number,"key": string,"payload": NonNullable<Json>,"provider": string
                  }
                  ComputedFields: never
                  Insert: {
                    "expires_at": string,"fetched_at"?: string,"hit_count"?: number,"key": string,"payload": NonNullable<Json>,"provider"?: string
                  }
                  Update: {
                    "expires_at"?: string,"fetched_at"?: string,"hit_count"?: number,"key"?: string,"payload"?: NonNullable<Json>,"provider"?: string
                  }
                  Relationships: [
                    
                  ]
                },"research_reports": {
                  Row: {
                    "bankruptcy_risk": Database["public"]['Enums']["bankruptcy_risk"] | null,"cited_evidence_ids": (number)[],"claims": NonNullable<Json>,"company_id": string,"completed_at": string | null,"conclusion": string | null,"created_at": string,"docs_fetched": number,"error": string | null,"evidence_trimmed": boolean | null,"fallback_reason": string | null,"id": string,"idempotency_key": string,"is_current": boolean,"kind": Database["public"]['Enums']["research_kind"],"last_attempt_at": string | null,"limitations": NonNullable<Json>,"material_damage_established": boolean | null,"missing_documents": NonNullable<Json>,"model": string | null,"news_summary": string | null,"next_attempt_at": string | null,"next_provider": string | null,"not_before": string | null,"prompt_version": string | null,"provider": string | null,"queries_used": number,"report_md": string | null,"research_cutoff_date": string | null,"scan_run_id": string | null,"schema_version": string | null,"security_id": string,"started_at": string | null,"status": Database["public"]['Enums']["research_status"],"step": string | null,"sufficient_evidence": boolean | null,"summary": string | null,"supersedes_id": string | null,"trigger": Database["public"]['Enums']["research_trigger"],"updated_at": string,"usage": NonNullable<Json>,"visibility": Database["public"]['Enums']["report_visibility"],"wait_reason": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "bankruptcy_risk"?: Database["public"]['Enums']["bankruptcy_risk"] | null,"cited_evidence_ids"?: (number)[],"claims"?: NonNullable<Json>,"company_id": string,"completed_at"?: string | null,"conclusion"?: string | null,"created_at"?: string,"docs_fetched"?: number,"error"?: string | null,"evidence_trimmed"?: boolean | null,"fallback_reason"?: string | null,"id"?: string,"idempotency_key": string,"is_current"?: boolean,"kind"?: Database["public"]['Enums']["research_kind"],"last_attempt_at"?: string | null,"limitations"?: NonNullable<Json>,"material_damage_established"?: boolean | null,"missing_documents"?: NonNullable<Json>,"model"?: string | null,"news_summary"?: string | null,"next_attempt_at"?: string | null,"next_provider"?: string | null,"not_before"?: string | null,"prompt_version"?: string | null,"provider"?: string | null,"queries_used"?: number,"report_md"?: string | null,"research_cutoff_date"?: string | null,"scan_run_id"?: string | null,"schema_version"?: string | null,"security_id": string,"started_at"?: string | null,"status"?: Database["public"]['Enums']["research_status"],"step"?: string | null,"sufficient_evidence"?: boolean | null,"summary"?: string | null,"supersedes_id"?: string | null,"trigger": Database["public"]['Enums']["research_trigger"],"updated_at"?: string,"usage"?: NonNullable<Json>,"visibility"?: Database["public"]['Enums']["report_visibility"],"wait_reason"?: string | null
                  }
                  Update: {
                    "bankruptcy_risk"?: Database["public"]['Enums']["bankruptcy_risk"] | null,"cited_evidence_ids"?: (number)[],"claims"?: NonNullable<Json>,"company_id"?: string,"completed_at"?: string | null,"conclusion"?: string | null,"created_at"?: string,"docs_fetched"?: number,"error"?: string | null,"evidence_trimmed"?: boolean | null,"fallback_reason"?: string | null,"id"?: string,"idempotency_key"?: string,"is_current"?: boolean,"kind"?: Database["public"]['Enums']["research_kind"],"last_attempt_at"?: string | null,"limitations"?: NonNullable<Json>,"material_damage_established"?: boolean | null,"missing_documents"?: NonNullable<Json>,"model"?: string | null,"news_summary"?: string | null,"next_attempt_at"?: string | null,"next_provider"?: string | null,"not_before"?: string | null,"prompt_version"?: string | null,"provider"?: string | null,"queries_used"?: number,"report_md"?: string | null,"research_cutoff_date"?: string | null,"scan_run_id"?: string | null,"schema_version"?: string | null,"security_id"?: string,"started_at"?: string | null,"status"?: Database["public"]['Enums']["research_status"],"step"?: string | null,"sufficient_evidence"?: boolean | null,"summary"?: string | null,"supersedes_id"?: string | null,"trigger"?: Database["public"]['Enums']["research_trigger"],"updated_at"?: string,"usage"?: NonNullable<Json>,"visibility"?: Database["public"]['Enums']["report_visibility"],"wait_reason"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "research_reports_company_id_fkey"
      columns: ["company_id"]
isOneToOne: false
      referencedRelation: "companies"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "research_reports_scan_run_id_fkey"
      columns: ["scan_run_id"]
isOneToOne: false
      referencedRelation: "scan_runs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "research_reports_security_id_fkey"
      columns: ["security_id"]
isOneToOne: false
      referencedRelation: "securities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "research_reports_security_id_fkey"
      columns: ["security_id"]
isOneToOne: false
      referencedRelation: "v_todays_discounts"
      referencedColumns: ["security_id"]
    },{
      foreignKeyName: "research_reports_supersedes_id_fkey"
      columns: ["supersedes_id"]
isOneToOne: false
      referencedRelation: "research_reports"
      referencedColumns: ["id"]
    }
                  ]
                },"research_sources": {
                  Row: {
                    "canonical_url": string,"content_hash": string | null,"content_type": string | null,"evidence_id": number,"excerpt": string | null,"extracted": NonNullable<Json>,"filing_date": string | null,"http_status": number | null,"id": number,"kind": string,"liveness_verified_at": string | null,"meta": NonNullable<Json>,"published_at": string | null,"publisher": string | null,"report_id": string,"retrieved_at": string | null,"title": string | null,"url": string,"used_in_report": boolean,"verification": string
                  }
                  ComputedFields: never
                  Insert: {
                    "canonical_url": string,"content_hash"?: string | null,"content_type"?: string | null,"evidence_id": number,"excerpt"?: string | null,"extracted"?: NonNullable<Json>,"filing_date"?: string | null,"http_status"?: number | null,"id"?: never,"kind": string,"liveness_verified_at"?: string | null,"meta"?: NonNullable<Json>,"published_at"?: string | null,"publisher"?: string | null,"report_id": string,"retrieved_at"?: string | null,"title"?: string | null,"url": string,"used_in_report"?: boolean,"verification"?: string
                  }
                  Update: {
                    "canonical_url"?: string,"content_hash"?: string | null,"content_type"?: string | null,"evidence_id"?: number,"excerpt"?: string | null,"extracted"?: NonNullable<Json>,"filing_date"?: string | null,"http_status"?: number | null,"id"?: never,"kind"?: string,"liveness_verified_at"?: string | null,"meta"?: NonNullable<Json>,"published_at"?: string | null,"publisher"?: string | null,"report_id"?: string,"retrieved_at"?: string | null,"title"?: string | null,"url"?: string,"used_in_report"?: boolean,"verification"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "research_sources_report_id_fkey"
      columns: ["report_id"]
isOneToOne: false
      referencedRelation: "research_reports"
      referencedColumns: ["id"]
    }
                  ]
                },"research_work_texts": {
                  Row: {
                    "created_at": string,"evidence_id": number,"report_id": string,"text": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"evidence_id": number,"report_id": string,"text": string
                  }
                  Update: {
                    "created_at"?: string,"evidence_id"?: number,"report_id"?: string,"text"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "research_work_texts_report_id_fkey"
      columns: ["report_id"]
isOneToOne: false
      referencedRelation: "research_reports"
      referencedColumns: ["id"]
    }
                  ]
                },"risk_findings": {
                  Row: {
                    "category": string,"detected_at": string,"evidence": NonNullable<Json>,"fingerprint": string,"id": string,"notified_at": string | null,"report_id": string | null,"resolved_at": string | null,"security_id": string,"severity": string,"summary": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "category": string,"detected_at"?: string,"evidence"?: NonNullable<Json>,"fingerprint": string,"id"?: string,"notified_at"?: string | null,"report_id"?: string | null,"resolved_at"?: string | null,"security_id": string,"severity": string,"summary": string,"user_id": string
                  }
                  Update: {
                    "category"?: string,"detected_at"?: string,"evidence"?: NonNullable<Json>,"fingerprint"?: string,"id"?: string,"notified_at"?: string | null,"report_id"?: string | null,"resolved_at"?: string | null,"security_id"?: string,"severity"?: string,"summary"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "risk_findings_report_id_fkey"
      columns: ["report_id"]
isOneToOne: false
      referencedRelation: "research_reports"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "risk_findings_security_id_fkey"
      columns: ["security_id"]
isOneToOne: false
      referencedRelation: "securities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "risk_findings_security_id_fkey"
      columns: ["security_id"]
isOneToOne: false
      referencedRelation: "v_todays_discounts"
      referencedColumns: ["security_id"]
    }
                  ]
                },"risk_monitor_state": {
                  Row: {
                    "first_monitored_at": string,"last_category": Database["public"]['Enums']["operational_category"] | null,"last_check_at": string | null,"last_report_id": string | null,"last_seen_items": NonNullable<Json>,"next_due_at": string | null,"reasons": (string)[],"security_id": string,"status": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "first_monitored_at"?: string,"last_category"?: Database["public"]['Enums']["operational_category"] | null,"last_check_at"?: string | null,"last_report_id"?: string | null,"last_seen_items"?: NonNullable<Json>,"next_due_at"?: string | null,"reasons": (string)[],"security_id": string,"status"?: string,"user_id": string
                  }
                  Update: {
                    "first_monitored_at"?: string,"last_category"?: Database["public"]['Enums']["operational_category"] | null,"last_check_at"?: string | null,"last_report_id"?: string | null,"last_seen_items"?: NonNullable<Json>,"next_due_at"?: string | null,"reasons"?: (string)[],"security_id"?: string,"status"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "risk_monitor_state_last_report_id_fkey"
      columns: ["last_report_id"]
isOneToOne: false
      referencedRelation: "research_reports"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "risk_monitor_state_security_id_fkey"
      columns: ["security_id"]
isOneToOne: false
      referencedRelation: "securities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "risk_monitor_state_security_id_fkey"
      columns: ["security_id"]
isOneToOne: false
      referencedRelation: "v_todays_discounts"
      referencedColumns: ["security_id"]
    }
                  ]
                },"scan_events": {
                  Row: {
                    "at": string,"data": Json | null,"event": string,"id": number,"job_id": number | null,"level": string,"message": string | null,"scan_run_id": string | null,"security_id": string | null,"stage": Database["public"]['Enums']["job_stage"] | null
                  }
                  ComputedFields: never
                  Insert: {
                    "at"?: string,"data"?: Json | null,"event": string,"id"?: never,"job_id"?: number | null,"level": string,"message"?: string | null,"scan_run_id"?: string | null,"security_id"?: string | null,"stage"?: Database["public"]['Enums']["job_stage"] | null
                  }
                  Update: {
                    "at"?: string,"data"?: Json | null,"event"?: string,"id"?: never,"job_id"?: number | null,"level"?: string,"message"?: string | null,"scan_run_id"?: string | null,"security_id"?: string | null,"stage"?: Database["public"]['Enums']["job_stage"] | null
                  }
                  Relationships: [
                    
                  ]
                },"scan_jobs": {
                  Row: {
                    "attempts": number,"created_at": string,"finished_at": string | null,"id": number,"key": string,"last_error": string | null,"lease_until": string | null,"leased_by": string | null,"max_attempts": number,"not_before": string,"payload": NonNullable<Json>,"priority": number,"result": Json | null,"scan_run_id": string,"stage": Database["public"]['Enums']["job_stage"],"started_at": string | null,"status": Database["public"]['Enums']["job_status"]
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number,"created_at"?: string,"finished_at"?: string | null,"id"?: never,"key": string,"last_error"?: string | null,"lease_until"?: string | null,"leased_by"?: string | null,"max_attempts"?: number,"not_before"?: string,"payload"?: NonNullable<Json>,"priority"?: number,"result"?: Json | null,"scan_run_id": string,"stage": Database["public"]['Enums']["job_stage"],"started_at"?: string | null,"status"?: Database["public"]['Enums']["job_status"]
                  }
                  Update: {
                    "attempts"?: number,"created_at"?: string,"finished_at"?: string | null,"id"?: never,"key"?: string,"last_error"?: string | null,"lease_until"?: string | null,"leased_by"?: string | null,"max_attempts"?: number,"not_before"?: string,"payload"?: NonNullable<Json>,"priority"?: number,"result"?: Json | null,"scan_run_id"?: string,"stage"?: Database["public"]['Enums']["job_stage"],"started_at"?: string | null,"status"?: Database["public"]['Enums']["job_status"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "scan_jobs_scan_run_id_fkey"
      columns: ["scan_run_id"]
isOneToOne: false
      referencedRelation: "scan_runs"
      referencedColumns: ["id"]
    }
                  ]
                },"scan_runs": {
                  Row: {
                    "code_version": string | null,"coverage": NonNullable<Json>,"digest_cutoff_at": string | null,"digests_created_at": string | null,"errors_summary": NonNullable<Json>,"finished_at": string | null,"id": string,"last_heartbeat_at": string | null,"latest_session_date": string | null,"list_published_at": string | null,"results_published_at": string | null,"scan_date_local": string,"session_dates": NonNullable<Json>,"settings_snapshot": NonNullable<Json>,"started_at": string,"status": Database["public"]['Enums']["scan_status"],"trigger": string,"universe_sizes": NonNullable<Json>,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "code_version"?: string | null,"coverage"?: NonNullable<Json>,"digest_cutoff_at"?: string | null,"digests_created_at"?: string | null,"errors_summary"?: NonNullable<Json>,"finished_at"?: string | null,"id"?: string,"last_heartbeat_at"?: string | null,"latest_session_date"?: string | null,"list_published_at"?: string | null,"results_published_at"?: string | null,"scan_date_local": string,"session_dates"?: NonNullable<Json>,"settings_snapshot": NonNullable<Json>,"started_at"?: string,"status"?: Database["public"]['Enums']["scan_status"],"trigger"?: string,"universe_sizes"?: NonNullable<Json>,"updated_at"?: string
                  }
                  Update: {
                    "code_version"?: string | null,"coverage"?: NonNullable<Json>,"digest_cutoff_at"?: string | null,"digests_created_at"?: string | null,"errors_summary"?: NonNullable<Json>,"finished_at"?: string | null,"id"?: string,"last_heartbeat_at"?: string | null,"latest_session_date"?: string | null,"list_published_at"?: string | null,"results_published_at"?: string | null,"scan_date_local"?: string,"session_dates"?: NonNullable<Json>,"settings_snapshot"?: NonNullable<Json>,"started_at"?: string,"status"?: Database["public"]['Enums']["scan_status"],"trigger"?: string,"universe_sizes"?: NonNullable<Json>,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"scan_security_results": {
                  Row: {
                    "bars_hash": string | null,"channel": Json | null,"close": number | null,"computed_at": string,"freshness": Database["public"]['Enums']["freshness_status"] | null,"id": number,"market_cap_usd": number | null,"reason_codes": (string)[],"scan_run_id": string,"scope": string,"security_id": string,"session_date": string | null,"status": string,"tier1_member": boolean,"valid_bars": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "bars_hash"?: string | null,"channel"?: Json | null,"close"?: number | null,"computed_at"?: string,"freshness"?: Database["public"]['Enums']["freshness_status"] | null,"id"?: never,"market_cap_usd"?: number | null,"reason_codes"?: (string)[],"scan_run_id": string,"scope": string,"security_id": string,"session_date"?: string | null,"status": string,"tier1_member"?: boolean,"valid_bars"?: number | null
                  }
                  Update: {
                    "bars_hash"?: string | null,"channel"?: Json | null,"close"?: number | null,"computed_at"?: string,"freshness"?: Database["public"]['Enums']["freshness_status"] | null,"id"?: never,"market_cap_usd"?: number | null,"reason_codes"?: (string)[],"scan_run_id"?: string,"scope"?: string,"security_id"?: string,"session_date"?: string | null,"status"?: string,"tier1_member"?: boolean,"valid_bars"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "scan_security_results_scan_run_id_fkey"
      columns: ["scan_run_id"]
isOneToOne: false
      referencedRelation: "scan_runs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "scan_security_results_security_id_fkey"
      columns: ["security_id"]
isOneToOne: false
      referencedRelation: "securities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "scan_security_results_security_id_fkey"
      columns: ["security_id"]
isOneToOne: false
      referencedRelation: "v_todays_discounts"
      referencedColumns: ["security_id"]
    }
                  ]
                },"securities": {
                  Row: {
                    "avg_usd_volume_30d": number | null,"company_id": string,"created_at": string,"currency": string,"currency_major": string,"exchange_code": string,"financial_currency": string | null,"first_trade_date": string | null,"id": string,"is_canonical": boolean,"isin": string | null,"long_name": string | null,"minor_divisor": number,"missing_scans": number,"no_bars_scans": number,"quote_type": string,"role": string,"shares_outstanding": number | null,"status": string,"symbol_history": NonNullable<Json>,"updated_at": string,"volume_probe_at": string | null,"yahoo_symbol": string
                  }
                  ComputedFields: never
                  Insert: {
                    "avg_usd_volume_30d"?: number | null,"company_id": string,"created_at"?: string,"currency": string,"currency_major": string,"exchange_code": string,"financial_currency"?: string | null,"first_trade_date"?: string | null,"id"?: string,"is_canonical"?: boolean,"isin"?: string | null,"long_name"?: string | null,"minor_divisor"?: number,"missing_scans"?: number,"no_bars_scans"?: number,"quote_type": string,"role"?: string,"shares_outstanding"?: number | null,"status"?: string,"symbol_history"?: NonNullable<Json>,"updated_at"?: string,"volume_probe_at"?: string | null,"yahoo_symbol": string
                  }
                  Update: {
                    "avg_usd_volume_30d"?: number | null,"company_id"?: string,"created_at"?: string,"currency"?: string,"currency_major"?: string,"exchange_code"?: string,"financial_currency"?: string | null,"first_trade_date"?: string | null,"id"?: string,"is_canonical"?: boolean,"isin"?: string | null,"long_name"?: string | null,"minor_divisor"?: number,"missing_scans"?: number,"no_bars_scans"?: number,"quote_type"?: string,"role"?: string,"shares_outstanding"?: number | null,"status"?: string,"symbol_history"?: NonNullable<Json>,"updated_at"?: string,"volume_probe_at"?: string | null,"yahoo_symbol"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "securities_company_id_fkey"
      columns: ["company_id"]
isOneToOne: false
      referencedRelation: "companies"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "securities_exchange_code_fkey"
      columns: ["exchange_code"]
isOneToOne: false
      referencedRelation: "exchanges"
      referencedColumns: ["code"]
    },{
      foreignKeyName: "securities_exchange_code_fkey"
      columns: ["exchange_code"]
isOneToOne: false
      referencedRelation: "v_todays_discounts"
      referencedColumns: ["exchange_code"]
    }
                  ]
                },"security_identity_overrides": {
                  Row: {
                    "active": boolean,"created_at": string,"created_by": string | null,"id": string,"kind": string,"payload": NonNullable<Json>,"reason": string,"target_company_id": string | null,"yahoo_symbol": string
                  }
                  ComputedFields: never
                  Insert: {
                    "active"?: boolean,"created_at"?: string,"created_by"?: string | null,"id"?: string,"kind": string,"payload"?: NonNullable<Json>,"reason": string,"target_company_id"?: string | null,"yahoo_symbol": string
                  }
                  Update: {
                    "active"?: boolean,"created_at"?: string,"created_by"?: string | null,"id"?: string,"kind"?: string,"payload"?: NonNullable<Json>,"reason"?: string,"target_company_id"?: string | null,"yahoo_symbol"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "security_identity_overrides_target_company_id_fkey"
      columns: ["target_company_id"]
isOneToOne: false
      referencedRelation: "companies"
      referencedColumns: ["id"]
    }
                  ]
                },"signal_episodes": {
                  Row: {
                    "close_reason": string | null,"closed_scan_run_id": string | null,"closed_session_date": string | null,"company_id": string,"continues_episode_id": string | null,"created_at": string,"id": string,"kind": Database["public"]['Enums']["signal_kind"],"last_evaluated_session_date": string,"mode": Database["public"]['Enums']["universe_mode"],"notify": boolean,"open_reason": string,"opened_close": number,"opened_line_value": number,"opened_rank": number | null,"opened_scan_run_id": string,"opened_session_date": string,"rank_history": NonNullable<Json>,"security_id": string,"status": Database["public"]['Enums']["episode_status"],"threshold_line": Database["public"]['Enums']["threshold_line"],"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "close_reason"?: string | null,"closed_scan_run_id"?: string | null,"closed_session_date"?: string | null,"company_id": string,"continues_episode_id"?: string | null,"created_at"?: string,"id"?: string,"kind": Database["public"]['Enums']["signal_kind"],"last_evaluated_session_date": string,"mode": Database["public"]['Enums']["universe_mode"],"notify"?: boolean,"open_reason": string,"opened_close": number,"opened_line_value": number,"opened_rank"?: number | null,"opened_scan_run_id": string,"opened_session_date": string,"rank_history"?: NonNullable<Json>,"security_id": string,"status"?: Database["public"]['Enums']["episode_status"],"threshold_line": Database["public"]['Enums']["threshold_line"],"updated_at"?: string
                  }
                  Update: {
                    "close_reason"?: string | null,"closed_scan_run_id"?: string | null,"closed_session_date"?: string | null,"company_id"?: string,"continues_episode_id"?: string | null,"created_at"?: string,"id"?: string,"kind"?: Database["public"]['Enums']["signal_kind"],"last_evaluated_session_date"?: string,"mode"?: Database["public"]['Enums']["universe_mode"],"notify"?: boolean,"open_reason"?: string,"opened_close"?: number,"opened_line_value"?: number,"opened_rank"?: number | null,"opened_scan_run_id"?: string,"opened_session_date"?: string,"rank_history"?: NonNullable<Json>,"security_id"?: string,"status"?: Database["public"]['Enums']["episode_status"],"threshold_line"?: Database["public"]['Enums']["threshold_line"],"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "signal_episodes_closed_scan_run_id_fkey"
      columns: ["closed_scan_run_id"]
isOneToOne: false
      referencedRelation: "scan_runs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "signal_episodes_company_id_fkey"
      columns: ["company_id"]
isOneToOne: false
      referencedRelation: "companies"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "signal_episodes_continues_episode_id_fkey"
      columns: ["continues_episode_id"]
isOneToOne: false
      referencedRelation: "signal_episodes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "signal_episodes_opened_scan_run_id_fkey"
      columns: ["opened_scan_run_id"]
isOneToOne: false
      referencedRelation: "scan_runs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "signal_episodes_security_id_fkey"
      columns: ["security_id"]
isOneToOne: false
      referencedRelation: "securities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "signal_episodes_security_id_fkey"
      columns: ["security_id"]
isOneToOne: false
      referencedRelation: "v_todays_discounts"
      referencedColumns: ["security_id"]
    }
                  ]
                },"todays_discounts": {
                  Row: {
                    "bankruptcy_risk": Database["public"]['Enums']["bankruptcy_risk"] | null,"category_reason": string,"channel": NonNullable<Json>,"close": number,"company_id": string,"conclusion": string | null,"created_at": string,"currency": string,"data_freshness": Database["public"]['Enums']["freshness_status"],"display_order": number,"eligibility": NonNullable<Json>,"episode_id": string,"eur_equivalent_id": string | null,"id": number,"is_new_episode": boolean,"lower_line_end": number,"market_cap_ccy": string | null,"market_cap_native": number | null,"market_cap_usd": number | null,"mode": Database["public"]['Enums']["universe_mode"],"operational_category": Database["public"]['Enums']["operational_category"],"rank": number,"report_id": string | null,"research_completed_at": string | null,"research_report_id": string | null,"research_summary": string | null,"scan_run_id": string,"security_id": string,"session_date": string,"summary": string | null,"threshold_line": Database["public"]['Enums']["threshold_line"],"trend_ok": boolean,"withheld": boolean
                  }
                  ComputedFields: never
                  Insert: {
                    "bankruptcy_risk"?: Database["public"]['Enums']["bankruptcy_risk"] | null,"category_reason": string,"channel": NonNullable<Json>,"close": number,"company_id": string,"conclusion"?: string | null,"created_at"?: string,"currency": string,"data_freshness": Database["public"]['Enums']["freshness_status"],"display_order": number,"eligibility": NonNullable<Json>,"episode_id": string,"eur_equivalent_id"?: string | null,"id"?: never,"is_new_episode": boolean,"lower_line_end": number,"market_cap_ccy"?: string | null,"market_cap_native"?: number | null,"market_cap_usd"?: number | null,"mode": Database["public"]['Enums']["universe_mode"],"operational_category": Database["public"]['Enums']["operational_category"],"rank": number,"report_id"?: string | null,"research_completed_at"?: string | null,"research_report_id"?: string | null,"research_summary"?: string | null,"scan_run_id": string,"security_id": string,"session_date": string,"summary"?: string | null,"threshold_line": Database["public"]['Enums']["threshold_line"],"trend_ok": boolean,"withheld"?: boolean
                  }
                  Update: {
                    "bankruptcy_risk"?: Database["public"]['Enums']["bankruptcy_risk"] | null,"category_reason"?: string,"channel"?: NonNullable<Json>,"close"?: number,"company_id"?: string,"conclusion"?: string | null,"created_at"?: string,"currency"?: string,"data_freshness"?: Database["public"]['Enums']["freshness_status"],"display_order"?: number,"eligibility"?: NonNullable<Json>,"episode_id"?: string,"eur_equivalent_id"?: string | null,"id"?: never,"is_new_episode"?: boolean,"lower_line_end"?: number,"market_cap_ccy"?: string | null,"market_cap_native"?: number | null,"market_cap_usd"?: number | null,"mode"?: Database["public"]['Enums']["universe_mode"],"operational_category"?: Database["public"]['Enums']["operational_category"],"rank"?: number,"report_id"?: string | null,"research_completed_at"?: string | null,"research_report_id"?: string | null,"research_summary"?: string | null,"scan_run_id"?: string,"security_id"?: string,"session_date"?: string,"summary"?: string | null,"threshold_line"?: Database["public"]['Enums']["threshold_line"],"trend_ok"?: boolean,"withheld"?: boolean
                  }
                  Relationships: [
                    {
      foreignKeyName: "todays_discounts_company_id_fkey"
      columns: ["company_id"]
isOneToOne: false
      referencedRelation: "companies"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "todays_discounts_episode_id_fkey"
      columns: ["episode_id"]
isOneToOne: false
      referencedRelation: "signal_episodes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "todays_discounts_eur_equivalent_fk"
      columns: ["eur_equivalent_id"]
isOneToOne: false
      referencedRelation: "eur_equivalents"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "todays_discounts_research_report_id_fkey"
      columns: ["research_report_id"]
isOneToOne: false
      referencedRelation: "research_reports"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "todays_discounts_scan_run_id_fkey"
      columns: ["scan_run_id"]
isOneToOne: false
      referencedRelation: "scan_runs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "todays_discounts_security_id_fkey"
      columns: ["security_id"]
isOneToOne: false
      referencedRelation: "securities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "todays_discounts_security_id_fkey"
      columns: ["security_id"]
isOneToOne: false
      referencedRelation: "v_todays_discounts"
      referencedColumns: ["security_id"]
    }
                  ]
                },"universe_membership_events": {
                  Row: {
                    "company_id": string,"event": string,"event_date": string,"from_rank": number | null,"id": number,"mode": Database["public"]['Enums']["universe_mode"],"reason": string,"scan_run_id": string,"security_id": string | null,"to_rank": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"event": string,"event_date": string,"from_rank"?: number | null,"id"?: never,"mode": Database["public"]['Enums']["universe_mode"],"reason": string,"scan_run_id": string,"security_id"?: string | null,"to_rank"?: number | null
                  }
                  Update: {
                    "company_id"?: string,"event"?: string,"event_date"?: string,"from_rank"?: number | null,"id"?: never,"mode"?: Database["public"]['Enums']["universe_mode"],"reason"?: string,"scan_run_id"?: string,"security_id"?: string | null,"to_rank"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "universe_membership_events_company_id_fkey"
      columns: ["company_id"]
isOneToOne: false
      referencedRelation: "companies"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "universe_membership_events_scan_run_id_fkey"
      columns: ["scan_run_id"]
isOneToOne: false
      referencedRelation: "scan_runs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "universe_membership_events_security_id_fkey"
      columns: ["security_id"]
isOneToOne: false
      referencedRelation: "securities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "universe_membership_events_security_id_fkey"
      columns: ["security_id"]
isOneToOne: false
      referencedRelation: "v_todays_discounts"
      referencedColumns: ["security_id"]
    }
                  ]
                },"universe_snapshots": {
                  Row: {
                    "applicable_line": Database["public"]['Enums']["threshold_line"],"close": number | null,"company_id": string,"id": number,"is_discount": boolean,"is_top10": boolean,"lower_line_end": number | null,"lower_line_positive": boolean | null,"market_cap_usd": number,"mode": Database["public"]['Enums']["universe_mode"],"rank": number,"ranked_at": string,"scan_run_id": string,"security_id": string,"session_date": string | null,"state": string
                  }
                  ComputedFields: never
                  Insert: {
                    "applicable_line": Database["public"]['Enums']["threshold_line"],"close"?: number | null,"company_id": string,"id"?: never,"is_discount"?: boolean,"is_top10": boolean,"lower_line_end"?: number | null,"lower_line_positive"?: boolean | null,"market_cap_usd": number,"mode": Database["public"]['Enums']["universe_mode"],"rank": number,"ranked_at"?: string,"scan_run_id": string,"security_id": string,"session_date"?: string | null,"state"?: string
                  }
                  Update: {
                    "applicable_line"?: Database["public"]['Enums']["threshold_line"],"close"?: number | null,"company_id"?: string,"id"?: never,"is_discount"?: boolean,"is_top10"?: boolean,"lower_line_end"?: number | null,"lower_line_positive"?: boolean | null,"market_cap_usd"?: number,"mode"?: Database["public"]['Enums']["universe_mode"],"rank"?: number,"ranked_at"?: string,"scan_run_id"?: string,"security_id"?: string,"session_date"?: string | null,"state"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "universe_snapshots_company_id_fkey"
      columns: ["company_id"]
isOneToOne: false
      referencedRelation: "companies"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "universe_snapshots_scan_run_id_fkey"
      columns: ["scan_run_id"]
isOneToOne: false
      referencedRelation: "scan_runs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "universe_snapshots_security_id_fkey"
      columns: ["security_id"]
isOneToOne: false
      referencedRelation: "securities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "universe_snapshots_security_id_fkey"
      columns: ["security_id"]
isOneToOne: false
      referencedRelation: "v_todays_discounts"
      referencedColumns: ["security_id"]
    }
                  ]
                }
          }
          Views: {
            "v_card_research": {
                  Row: {
                    "bankruptcy_risk": Database["public"]['Enums']["bankruptcy_risk"] | null,"category_reason": string | null,"conclusion": string | null,"evidence_trimmed": boolean | null,"fallback_reason": string | null,"last_attempt_at": string | null,"mode": Database["public"]['Enums']["universe_mode"] | null,"model": string | null,"next_attempt_at": string | null,"next_provider": string | null,"operational_category": Database["public"]['Enums']["operational_category"] | null,"prompt_version": string | null,"provider": string | null,"report_error": string | null,"report_status": Database["public"]['Enums']["research_status"] | null,"report_step": string | null,"research_completed_at": string | null,"research_model": string | null,"research_provider": string | null,"research_report_id": string | null,"research_summary": string | null,"scan_run_id": string | null,"security_id": string | null,"wait_reason": string | null,"withheld": boolean | null
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "todays_discounts_research_report_id_fkey"
      columns: ["research_report_id"]
isOneToOne: false
      referencedRelation: "research_reports"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "todays_discounts_scan_run_id_fkey"
      columns: ["scan_run_id"]
isOneToOne: false
      referencedRelation: "scan_runs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "todays_discounts_security_id_fkey"
      columns: ["security_id"]
isOneToOne: false
      referencedRelation: "securities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "todays_discounts_security_id_fkey"
      columns: ["security_id"]
isOneToOne: false
      referencedRelation: "v_todays_discounts"
      referencedColumns: ["security_id"]
    }
                  ]
                },"v_todays_discounts": {
                  Row: {
                    "bankruptcy_risk": Database["public"]['Enums']["bankruptcy_risk"] | null,"category_reason": string | null,"close": number | null,"conclusion": string | null,"country": string | null,"currency": string | null,"data_freshness": Database["public"]['Enums']["freshness_status"] | null,"display_order": number | null,"eur_status": string | null,"eur_symbol_yahoo": string | null,"eur_verified_at": string | null,"evidence_trimmed": boolean | null,"exchange_code": string | null,"exchange_name": string | null,"fallback_reason": string | null,"ibkr_exchange_id": string | null,"ibkr_local_symbol": string | null,"is_new_episode": boolean | null,"is_top10": boolean | null,"last_attempt_at": string | null,"line3_end": number | null,"line4_end": number | null,"listing_country": string | null,"lower_line_end": number | null,"mode": Database["public"]['Enums']["universe_mode"] | null,"name": string | null,"next_attempt_at": string | null,"next_provider": string | null,"operational_category": Database["public"]['Enums']["operational_category"] | null,"rank": number | null,"reached_line4": boolean | null,"report_id": string | null,"research_completed_at": string | null,"research_failed_at": string | null,"research_failed_reason": string | null,"research_model": string | null,"research_provider": string | null,"research_requested_by": string | null,"research_started_at": string | null,"research_wait_reason": string | null,"scan_run_id": string | null,"security_id": string | null,"session_date": string | null,"since_date": string | null,"summary": string | null,"threshold_line": Database["public"]['Enums']["threshold_line"] | null,"wait_reason": string | null,"withheld": boolean | null,"yahoo_symbol": string | null
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "todays_discounts_scan_run_id_fkey"
      columns: ["scan_run_id"]
isOneToOne: false
      referencedRelation: "scan_runs"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Functions: {
            "company_list":
{ Args: { "p_after_rank"?: number,"p_country"?: string,"p_limit"?: number,"p_mode": Database["public"]['Enums']["universe_mode"] }; Returns: {
              "applicable_line": Database["public"]['Enums']["threshold_line"],"change_pct": number,"company_id": string,"country": string,"currency": string,"is_discount": boolean,"is_top10": boolean,"last_close": number,"listing_country": string,"lower_line_positive": boolean,"market_cap_ccy": string,"market_cap_native": number,"market_cap_usd": number,"name": string,"prev_close": number,"price_freshness": Database["public"]['Enums']["freshness_status"],"rank": number,"security_id": string,"session_date": string,"state": string,"total_count": number,"yahoo_symbol": string
            }[]
                           },
"consume_quota_rpc":
{ Args: { "p_amount": number,"p_limit": number,"p_period_kind": string,"p_provider": string,"p_resource": string }; Returns: boolean
                           },
"get_price_series":
{ Args: { "p_security_id": string }; Returns: {
              "adjustment_policy": string,
"bar_count": number,
"bar_dates": (number)[],
"close": (number)[],
"completeness": NonNullable<Json>,
"first_bar_date": string,
"freshness": Database["public"]['Enums']["freshness_status"],
"high": (number)[],
"last_bar_date": string,
"last_close": number,
"last_full_refresh_at": string,
"last_session_date": string,
"low": (number)[],
"open": (number)[],
"prev_close": number | null,
"provider": string,
"retrieved_at": string,
"security_id": string,
"updated_at": string,
"volume": (number)[]
            }
                          SetofOptions: {
        from: "*"
        to: "price_series"
        isOneToOne: true
        isSetofReturn: false
      } },
"holds_security":
{ Args: { "p_security_id": string }; Returns: boolean
                           },
"is_admin":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"monitored_holdings_for":
{ Args: { "p_user": string }; Returns: {
              "conid": number,"isin": string,"quantity": number,"report_date": string,"security_id": string,"signal_security_id": string,"symbol": string
            }[]
                           },
"notify_active_subscriptions":
{ Args: { "p_user": string }; Returns: {
              "auth": string,"endpoint": string,"id": string,"p256dh": string
            }[]
                           },
"notify_claim_deliveries":
{ Args: { "p_limit": number }; Returns: Json[]
                           },
"notify_claim_push_test":
{ Args: { "p_user": string }; Returns: boolean
                           },
"notify_complete_delivery":
{ Args: { "p_error": string,"p_id": string,"p_log": Json,"p_message_id": string,"p_retry_in_seconds": number,"p_skip_reason": string,"p_status": Database["public"]['Enums']["delivery_status"] }; Returns: undefined
                           },
"notify_consume_email_quota":
{ Args: { "p_delivery": string,"p_limit": number }; Returns: boolean
                           },
"notify_cutoff_digests":
{ Args: { "p_now"?: string }; Returns: number
                           },
"notify_defer_delivery":
{ Args: { "p_error": string,"p_id": string,"p_log": Json,"p_retry_in_seconds": number }; Returns: undefined
                           },
"notify_digest_users":
{ Args: Record<PropertyKey, never>; Returns: {
              "digest_modes": (Database["public"]['Enums']["universe_mode"])[],"email_enabled": boolean,"email_ok": boolean,"has_active_push": boolean,"holds_positions": boolean,"push_enabled": boolean,"send_empty": boolean,"user_id": string
            }[]
                           },
"notify_discount_candidates":
{ Args: { "p_finished_only": boolean,"p_scan_run": string,"p_user": string }; Returns: {
              "bankruptcy_risk": string,"category": string,"close": number,"company_id": string,"conclusion": string,"currency": string,"episode_id": string,"eur_status": string,"eur_symbol": string,"exchange_code": string,"is_top10": boolean,"mode": Database["public"]['Enums']["universe_mode"],"name": string,"rank": number,"reached_line4": boolean,"security_id": string,"session_date": string,"summary": string,"threshold_line": string,"yahoo_symbol": string
            }[]
                           },
"notify_event":
{ Args: { "p_data"?: Json,"p_event": string,"p_level": string,"p_scan_run": string }; Returns: undefined
                           },
"notify_finish_digests":
{ Args: { "p_reason": string,"p_scan_run": string,"p_stats": Json }; Returns: boolean
                           },
"notify_insert_digest":
{ Args: { "p_channels": Json,"p_content": Json,"p_hash": string,"p_items": Json,"p_kind": Database["public"]['Enums']["digest_kind"],"p_reason": string,"p_scan_date": string,"p_scan_run": string,"p_skip_reason": string,"p_status": string,"p_user": string }; Returns: string
                           },
"notify_mark_subscription":
{ Args: { "p_id": string,"p_outcome": string }; Returns: undefined
                           },
"notify_portfolio_candidates":
{ Args: { "p_scan_run": string,"p_user": string }; Returns: Json
                           },
"notify_recipient_candidates":
{ Args: Record<PropertyKey, never>; Returns: {
              "email": string,"user_id": string
            }[]
                           },
"notify_record_email_event":
{ Args: { "p_email_id": string,"p_payload": Json,"p_recipient_hash": string,"p_svix_id": string,"p_type": string,"p_user"?: string }; Returns: string
                           },
"notify_subscribe":
{ Args: { "p_auth": string,"p_endpoint": string,"p_max": number,"p_p256dh": string,"p_user": string,"p_user_agent": string }; Returns: string
                           },
"notify_unsubscribe":
{ Args: { "p_user": string }; Returns: undefined
                           },
"promote_research_report_rpc":
{ Args: { "p_report_id": string }; Returns: string
                           },
"quotes_rl_incr":
{ Args: { "p_expires": string,"p_key": string }; Returns: number
                           },
"record_audit":
{ Args: { "p_meta"?: Json,"p_type": string }; Returns: undefined
                           },
"research_quota_status":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"scan_status":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"todays_discounts_feed":
{ Args: { "p_mode": Database["public"]['Enums']["universe_mode"] }; Returns: {
              "bankruptcy_risk": Database["public"]['Enums']["bankruptcy_risk"] | null,
"category_reason": string | null,
"close": number | null,
"conclusion": string | null,
"country": string | null,
"currency": string | null,
"data_freshness": Database["public"]['Enums']["freshness_status"] | null,
"display_order": number | null,
"eur_status": string | null,
"eur_symbol_yahoo": string | null,
"eur_verified_at": string | null,
"evidence_trimmed": boolean | null,
"exchange_code": string | null,
"exchange_name": string | null,
"fallback_reason": string | null,
"ibkr_exchange_id": string | null,
"ibkr_local_symbol": string | null,
"is_new_episode": boolean | null,
"is_top10": boolean | null,
"last_attempt_at": string | null,
"line3_end": number | null,
"line4_end": number | null,
"listing_country": string | null,
"lower_line_end": number | null,
"mode": Database["public"]['Enums']["universe_mode"] | null,
"name": string | null,
"next_attempt_at": string | null,
"next_provider": string | null,
"operational_category": Database["public"]['Enums']["operational_category"] | null,
"rank": number | null,
"reached_line4": boolean | null,
"report_id": string | null,
"research_completed_at": string | null,
"research_failed_at": string | null,
"research_failed_reason": string | null,
"research_model": string | null,
"research_provider": string | null,
"research_requested_by": string | null,
"research_started_at": string | null,
"research_wait_reason": string | null,
"scan_run_id": string | null,
"security_id": string | null,
"session_date": string | null,
"since_date": string | null,
"summary": string | null,
"threshold_line": Database["public"]['Enums']["threshold_line"] | null,
"wait_reason": string | null,
"withheld": boolean | null,
"yahoo_symbol": string | null
            }[]
                          SetofOptions: {
        from: "*"
        to: "v_todays_discounts"
        isOneToOne: false
        isSetofReturn: true
      } },
"universe_summary":
{ Args: { "p_mode": Database["public"]['Enums']["universe_mode"] }; Returns: Json
                           }
          }
          Enums: {
            "bankruptcy_risk": "Low"|"Moderate"|"High"|"Unclear","broker_status": "unlinked"|"linking"|"linked"|"error"|"expired","delivery_channel": "push"|"email","delivery_status": "pending"|"sent"|"failed"|"skipped"|"bounced","digest_kind": "discounts"|"portfolio","episode_status": "active"|"closed","eur_status": "verified"|"unverified"|"none","freshness_status": "fresh"|"stale"|"unavailable","job_stage": "fx"|"universe_sweep"|"identity"|"volume_probe"|"fetch_bars"|"compute"|"rank_signals"|"portfolio_scan"|"news"|"research"|"classify"|"publish"|"digest"|"eur_catalogue"|"eur_resolve","job_status": "queued"|"leased"|"done"|"failed"|"dead","operational_category": "green"|"amber"|"red"|"grey"|"pending","report_visibility": "public"|"holders","research_kind": "full"|"change_check","research_status": "queued"|"running"|"complete"|"failed"|"quota_deferred"|"stale","research_trigger": "new_discount"|"premium"|"monitor_first"|"monitor_change"|"refresh"|"manual"|"visitor","scan_status": "queued"|"running"|"partial"|"complete"|"failed","signal_kind": "discount"|"premium1"|"premium2","sync_state": "queued"|"requested"|"polling"|"parsing"|"done"|"failed"|"expired","threshold_line": "-3"|"-4"|"+1"|"+2","universe_mode": "worldwide"|"us","venue_class": "primary"|"secondary_only"|"otc"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            "bankruptcy_risk": ["Low", "Moderate", "High", "Unclear"],"broker_status": ["unlinked", "linking", "linked", "error", "expired"],"delivery_channel": ["push", "email"],"delivery_status": ["pending", "sent", "failed", "skipped", "bounced"],"digest_kind": ["discounts", "portfolio"],"episode_status": ["active", "closed"],"eur_status": ["verified", "unverified", "none"],"freshness_status": ["fresh", "stale", "unavailable"],"job_stage": ["fx", "universe_sweep", "identity", "volume_probe", "fetch_bars", "compute", "rank_signals", "portfolio_scan", "news", "research", "classify", "publish", "digest", "eur_catalogue", "eur_resolve"],"job_status": ["queued", "leased", "done", "failed", "dead"],"operational_category": ["green", "amber", "red", "grey", "pending"],"report_visibility": ["public", "holders"],"research_kind": ["full", "change_check"],"research_status": ["queued", "running", "complete", "failed", "quota_deferred", "stale"],"research_trigger": ["new_discount", "premium", "monitor_first", "monitor_change", "refresh", "manual", "visitor"],"scan_status": ["queued", "running", "partial", "complete", "failed"],"signal_kind": ["discount", "premium1", "premium2"],"sync_state": ["queued", "requested", "polling", "parsing", "done", "failed", "expired"],"threshold_line": ["-3", "-4", "+1", "+2"],"universe_mode": ["worldwide", "us"],"venue_class": ["primary", "secondary_only", "otc"]
          }
        }
} as const

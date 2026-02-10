import pandas as pd
import yfinance as yf
from datetime import datetime, timedelta

# -------- CONFIG --------
INPUT_CSV = "ind_niftylargemidcap250list.csv"
OUTPUT_CSV = "historical_11y_data.csv"
YEARS = 11
# ------------------------

def fetch_historical_data():
    try:
        symbols_df = pd.read_csv(INPUT_CSV)
    except Exception as e:
        print(f"❌ Failed to read input CSV: {e}")
        return

    if "Symbol" not in symbols_df.columns:
        print("❌ Input CSV must contain a 'Symbol' column")
        return

    # Clean symbols and remove duplicates
    symbols = symbols_df["Symbol"].dropna().astype(str).str.strip().unique()

    all_data = []

    for symbol in symbols:
        ticker_symbol = f"{symbol}.NS"
        print(f"\nFetching data for {ticker_symbol}...")

        try:
            # period="11y" is more reliable than manual date subtraction for yfinance
            df = yf.download(
                ticker_symbol,
                period=f"{YEARS}y",
                progress=False,
                auto_adjust=False
            )

            if df.empty:
                print(f"⚠ No data found for {symbol}.")
                continue

            # FIX: yfinance now often returns MultiIndex columns. 
            # This flattens them to just ['Open', 'High', etc.]
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = df.columns.get_level_values(0)

            df.reset_index(inplace=True)
            
            # Standardize column names to lowercase
            df.columns = [col.lower() for col in df.columns]

            # Select and order required columns
            required_cols = ["date", "open", "high", "close", "low", "volume"]
            # Filter only columns that exist (in case one is missing)
            df = df[[col for col in required_cols if col in df.columns]]

            # Drop rows where major price data is missing
            df.dropna(subset=["close"], inplace=True)

            # Add symbol column at the start
            df.insert(0, "symbol", symbol)

            print(f"✔ {symbol}: {df['date'].min().date()} to {df['date'].max().date()} ({len(df)} rows)")
            all_data.append(df)

        except Exception as e:
            print(f"❌ Error fetching {symbol}: {e}")

    if not all_data:
        print("❌ No data collected. Check your symbol list or internet connection.")
        return

    # Combine all dataframes
    final_df = pd.concat(all_data, ignore_index=True)

    # Final cleanup: Ensure date is just the date string if desired
    final_df['date'] = pd.to_datetime(final_df['date']).dt.strftime('%Y-%m-%d')

    # Save output
    final_df.to_csv(OUTPUT_CSV, index=False)

    print(f"\n✅ Final data saved to: {OUTPUT_CSV}")
    print(f"📊 Total records: {len(final_df)}")

if __name__ == "__main__":
    fetch_historical_data()
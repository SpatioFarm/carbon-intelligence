"""
db_setup.py  —  Run this ONCE to load all data into databases
=============================================================
What this script does, step by step:
  1. Connects to PostgreSQL and creates 3 tables with PostGIS geometry
  2. Reads your CSV files and loads 66,700 grid cells into PostgreSQL
  3. Connects to MongoDB and creates 3 collections
  4. Loads carbon predictions and model metadata into MongoDB

Run it like this (only once):
  python db_setup.py

After it finishes, your databases are ready forever.
You never need to run this again unless you reset your databases.
"""

import psycopg2          # Python talks to PostgreSQL
import psycopg2.extras   # helps insert many rows at once
from pymongo import MongoClient  # Python talks to MongoDB
import pandas as pd      # reads CSV files
import numpy as np       # number calculations
import re                # parses text (for WKT geometry)
import sys               # for progress printing

# ══════════════════════════════════════════════════════════
# CONFIGURATION — change these if your setup is different
# ══════════════════════════════════════════════════════════

# Your folder path — where all your CSV files are
FOLDER = r"C:\BDA PROJECT\.venv\IIRS\Carbon_Stocks"

# PostgreSQL connection details
PG_HOST     = "localhost"
PG_DATABASE = "postgres"
PG_USER     = "postgres"
PG_PASSWORD = "Sathvik@6"   # your pgAdmin password

# MongoDB connection
MONGO_URI = "mongodb://localhost:27017/"
MONGO_DB  = "carbon_stock_ludhiana"

import os

def path(filename):
    """Returns full path for a file in your Carbon_Stocks folder."""
    return os.path.join(FOLDER, filename)

# ══════════════════════════════════════════════════════════
# HELPER — print progress
# ══════════════════════════════════════════════════════════
def log(msg):
    print(f"  ✓  {msg}")

def section(title):
    print(f"\n{'='*55}")
    print(f"  {title}")
    print(f"{'='*55}")

# ══════════════════════════════════════════════════════════
# STEP 1 — POSTGRESQL SETUP
# Creates 3 tables:
#   grid_cells      → stores the 66k polygon geometries + features
#   ndvi_monthly    → stores monthly NDVI for each cell
#   district_summary → stores the final carbon totals
# ══════════════════════════════════════════════════════════

def setup_postgresql():
    section("STEP 1 — Setting up PostgreSQL + PostGIS")

    # Connect to PostgreSQL
    conn = psycopg2.connect(
        host=PG_HOST, database=PG_DATABASE,
        user=PG_USER, password=PG_PASSWORD
    )
    conn.autocommit = True
    cur = conn.cursor()
    log("Connected to PostgreSQL")

    # Make sure PostGIS extension is active
    cur.execute("CREATE EXTENSION IF NOT EXISTS postgis;")
    log("PostGIS extension confirmed active")

    # ── Create grid_cells table ─────────────────────────
    # This stores one row per grid cell with its polygon geometry
    # geom column is a PostGIS geometry type — stores the real WKT polygon
    cur.execute("""
        DROP TABLE IF EXISTS grid_cells CASCADE;
        CREATE TABLE grid_cells (
            id          SERIAL PRIMARY KEY,
            grid_id     INTEGER,
            geom        GEOMETRY(MULTIPOLYGON, 4326),
            agri_class  INTEGER,
            agnonag_m   FLOAT,
            dem_mean    FLOAT,
            slope_mean  FLOAT,
            sand_pct    FLOAT,
            clay_pct    FLOAT,
            bd_gcm3     FLOAT
        );
    """)
    log("Created table: grid_cells")

    # ── Create ndvi_monthly table ───────────────────────
    # Stores 12 monthly NDVI values per grid cell
    cur.execute("""
        DROP TABLE IF EXISTS ndvi_monthly CASCADE;
        CREATE TABLE ndvi_monthly (
            id          SERIAL PRIMARY KEY,
            grid_id     INTEGER,
            ndvi_jun24  FLOAT, ndvi_jul24 FLOAT, ndvi_aug24 FLOAT,
            ndvi_sep24  FLOAT, ndvi_oct24 FLOAT, ndvi_nov24 FLOAT,
            ndvi_dec24  FLOAT, ndvi_jan25 FLOAT, ndvi_feb25 FLOAT,
            ndvi_mar25  FLOAT, ndvi_apr25 FLOAT, ndvi_may25 FLOAT,
            kharif_mean FLOAT,
            rabi_mean   FLOAT
        );
    """)
    log("Created table: ndvi_monthly")

    # ── Create district_summary table ──────────────────
    cur.execute("""
        DROP TABLE IF EXISTS district_summary CASCADE;
        CREATE TABLE district_summary (
            id              SERIAL PRIMARY KEY,
            run_date        TEXT,
            total_million_tc FLOAT,
            agc_million_tc  FLOAT,
            bgc_million_tc  FLOAT,
            co2e_million    FLOAT,
            agc_pct         FLOAT,
            bgc_pct         FLOAT,
            ag_r2           FLOAT,
            bg_r2           FLOAT,
            ag_rmse         FLOAT,
            bg_rmse         FLOAT,
            total_cells     INTEGER,
            agri_cells      INTEGER
        );
    """)
    log("Created table: district_summary")

    # ── Insert district summary row ─────────────────────
    cur.execute("""
        INSERT INTO district_summary
        (run_date, total_million_tc, agc_million_tc, bgc_million_tc,
         co2e_million, agc_pct, bgc_pct, ag_r2, bg_r2,
         ag_rmse, bg_rmse, total_cells, agri_cells)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
    """, (
        "2025-01-01",
        54.228, 1.6678, 52.5602,
        198.8541, 3.08, 96.92,
        0.5426, 0.9665, 448.597, 1.392,
        66790, 50402
    ))
    log("Inserted district summary row")

    # ── Load BGD file (has WKT + soil features) ─────────
    print("\n  Loading BGD_for_all_grids file...")
    bgd = pd.read_csv(path("BGD_for_all_grids(GEOM).csv"))

    # Deduplicate — keep row with highest Ag/NonAg_m per Grid_ID
    bgd = (bgd.sort_values("Ag/NonAg_m", ascending=False)
              .drop_duplicates(subset="Grid_ID", keep="first")
              .reset_index(drop=True))
    print(f"  After dedup: {len(bgd):,} unique grid cells")

    # Insert rows in batches of 1000 for speed
    batch = []
    total = len(bgd)
    for i, row in bgd.iterrows():
        wkt = str(row["WKT"])
        # ST_GeomFromText converts WKT text into a PostGIS geometry object
        # SRID 4326 means WGS84 — standard GPS coordinates
        batch.append((
            int(row["Grid_ID"]),
            wkt,
            int(row["agri_class"]),
            float(row["Ag/NonAg_m"]),
            float(row["DEM_mean"]),
            float(row["Slope_mean"]),
            float(row.get("sand_pct", 0) or 0),
            float(row.get("clay_pct", 0) or 0),
            float(row.get("BD_g_cm3", 1.5) or 1.5),
        ))

        # Insert every 1000 rows and show progress
        if len(batch) == 1000:
            psycopg2.extras.execute_batch(cur, """
                INSERT INTO grid_cells
                (grid_id, geom, agri_class, agnonag_m,
                 dem_mean, slope_mean, sand_pct, clay_pct, bd_gcm3)
                VALUES (%s, ST_GeomFromText(%s, 4326), %s, %s, %s, %s, %s, %s, %s)
            """, batch)
            batch = []
            pct = min(int((i+1)/total*100), 99)
            print(f"  Progress: {pct}% ({i+1:,}/{total:,} rows)", end="\r")

    # Insert any remaining rows
    if batch:
        psycopg2.extras.execute_batch(cur, """
            INSERT INTO grid_cells
            (grid_id, geom, agri_class, agnonag_m,
             dem_mean, slope_mean, sand_pct, clay_pct, bd_gcm3)
            VALUES (%s, ST_GeomFromText(%s, 4326), %s, %s, %s, %s, %s, %s, %s)
        """, batch)

    print(f"  Progress: 100% ({total:,}/{total:,} rows)")
    log(f"Loaded {total:,} grid cells into grid_cells table")

    # ── Create spatial index for fast map queries ───────
    # Without this index, every map query would be very slow
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_grid_cells_geom
        ON grid_cells USING GIST(geom);
    """)
    log("Created PostGIS spatial index (speeds up map queries)")

    # ── Load NDVI data ──────────────────────────────────
    print("\n  Loading NDVI data...")
    ndvi = pd.read_csv(path("ndvi_monthly_ludhiana_all_66790.csv"))
    ndvi = ndvi.drop_duplicates(subset="Grid_ID", keep="first").reset_index(drop=True)

    ndvi_cols = ["NDVI_Jun24","NDVI_Jul24","NDVI_Aug24","NDVI_Sep24",
                 "NDVI_Oct24","NDVI_Nov24","NDVI_Dec24","NDVI_Jan25",
                 "NDVI_Feb25","NDVI_Mar25","NDVI_Apr25","NDVI_May25"]

    # Fill missing values with monthly median
    for col in ndvi_cols:
        ndvi[col] = ndvi[col].fillna(ndvi[col].median())

    batch = []
    total = len(ndvi)
    for i, row in ndvi.iterrows():
        kharif = np.mean([row["NDVI_Jun24"], row["NDVI_Jul24"], row["NDVI_Aug24"],
                          row["NDVI_Sep24"], row["NDVI_Oct24"], row["NDVI_Nov24"]])
        rabi   = np.mean([row["NDVI_Dec24"], row["NDVI_Jan25"], row["NDVI_Feb25"],
                          row["NDVI_Mar25"], row["NDVI_Apr25"], row["NDVI_May25"]])
        batch.append((
            int(row["Grid_ID"]),
            float(row["NDVI_Jun24"]), float(row["NDVI_Jul24"]), float(row["NDVI_Aug24"]),
            float(row["NDVI_Sep24"]), float(row["NDVI_Oct24"]), float(row["NDVI_Nov24"]),
            float(row["NDVI_Dec24"]), float(row["NDVI_Jan25"]), float(row["NDVI_Feb25"]),
            float(row["NDVI_Mar25"]), float(row["NDVI_Apr25"]), float(row["NDVI_May25"]),
            round(float(kharif), 4), round(float(rabi), 4),
        ))
        if len(batch) == 2000:
            psycopg2.extras.execute_batch(cur, """
                INSERT INTO ndvi_monthly
                (grid_id, ndvi_jun24, ndvi_jul24, ndvi_aug24,
                 ndvi_sep24, ndvi_oct24, ndvi_nov24,
                 ndvi_dec24, ndvi_jan25, ndvi_feb25,
                 ndvi_mar25, ndvi_apr25, ndvi_may25,
                 kharif_mean, rabi_mean)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            """, batch)
            batch = []
            print(f"  NDVI progress: {int((i+1)/total*100)}%", end="\r")

    if batch:
        psycopg2.extras.execute_batch(cur, """
            INSERT INTO ndvi_monthly
            (grid_id, ndvi_jun24, ndvi_jul24, ndvi_aug24,
             ndvi_sep24, ndvi_oct24, ndvi_nov24,
             ndvi_dec24, ndvi_jan25, ndvi_feb25,
             ndvi_mar25, ndvi_apr25, ndvi_may25,
             kharif_mean, rabi_mean)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, batch)

    print(f"  NDVI progress: 100%")
    log(f"Loaded {total:,} NDVI records into ndvi_monthly table")

    cur.close()
    conn.close()
    log("PostgreSQL setup complete — connection closed")


# ══════════════════════════════════════════════════════════
# STEP 2 — MONGODB SETUP
# Creates 3 collections:
#   carbon_predictions → per-cell AG and BG carbon values
#   ndvi_summary       → monthly NDVI means for charts
#   model_metadata     → R², RMSE, feature importance
# ══════════════════════════════════════════════════════════

def setup_mongodb():
    section("STEP 2 — Setting up MongoDB")

    client = MongoClient(MONGO_URI)
    db     = client[MONGO_DB]
    log(f"Connected to MongoDB — database: {MONGO_DB}")

    # ── carbon_predictions collection ───────────────────
    # Drop and recreate so we start fresh
    db["carbon_predictions"].drop()

    ag = pd.read_csv(path("ag_carbon_per_cell.csv"))
    bg = pd.read_csv(path("bg_carbon_per_cell.csv"))

    # AG has 2,521 rows — BG has 4,000 rows — store separately
    ag_docs = []
    for i, row in ag.iterrows():
        ag_docs.append({
            "cell_index":     int(i),
            "pool":           "above_ground",
            "predicted_npp":  round(float(row["Predicted_NPP"]), 4),
            "agc_tC_ha":      round(float(row["AGC_tC_ha"]), 4),
            "true_npp":       round(float(row["True_NPP"]), 4),
        })

    bg_docs = []
    for i, row in bg.iterrows():
        bg_docs.append({
            "cell_index":    int(i),
            "pool":          "below_ground",
            "predicted_soc": round(float(row["Predicted_SOC"]), 4),
            "bd_gcm3":       round(float(row["BD"]), 4),
            "bgc_tC_ha":     round(float(row["BGC_tC_ha"]), 4),
            "true_soc":      round(float(row["True_SOC"]), 4),
        })

    db["ag_predictions"].drop()
    db["bg_predictions"].drop()
    db["ag_predictions"].insert_many(ag_docs)
    db["bg_predictions"].insert_many(bg_docs)
    log(f"Inserted {len(ag_docs):,} AG prediction records")
    log(f"Inserted {len(bg_docs):,} BG prediction records")

    # ── ndvi_summary collection ─────────────────────────
    # Monthly mean NDVI across all cells — for the NDVI chart
    db["ndvi_summary"].drop()
    ndvi = pd.read_csv(path("ndvi_monthly_ludhiana_all_66790.csv"))
    ndvi_cols = ["NDVI_Jun24","NDVI_Jul24","NDVI_Aug24","NDVI_Sep24",
                 "NDVI_Oct24","NDVI_Nov24","NDVI_Dec24","NDVI_Jan25",
                 "NDVI_Feb25","NDVI_Mar25","NDVI_Apr25","NDVI_May25"]
    for col in ndvi_cols:
        ndvi[col] = ndvi[col].fillna(ndvi[col].median())

    months_labels = ["Jun 24","Jul 24","Aug 24","Sep 24","Oct 24","Nov 24",
                     "Dec 24","Jan 25","Feb 25","Mar 25","Apr 25","May 25"]
    seasons        = ["Kharif"]*6 + ["Rabi"]*6

    ndvi_summary = []
    for i, (col, label, season) in enumerate(zip(ndvi_cols, months_labels, seasons)):
        ndvi_summary.append({
            "month":       label,
            "ndvi_column": col,
            "mean_ndvi":   round(float(ndvi[col].mean()), 4),
            "median_ndvi": round(float(ndvi[col].median()), 4),
            "season":      season,
            "sort_order":  i,
        })

    db["ndvi_summary"].insert_many(ndvi_summary)
    log(f"Inserted {len(ndvi_summary)} NDVI monthly summary records")

    # ── model_metadata collection ───────────────────────
    db["model_metadata"].drop()
    db["model_metadata"].insert_one({
        "run_date":          "2025-01-01",
        "ag_model":          "Random Forest",
        "bg_model":          "Random Forest",
        "ag_r2":             0.5426,
        "ag_rmse":           448.597,
        "ag_mae":            314.795,
        "bg_r2":             0.9665,
        "bg_rmse":           1.392,
        "bg_mae":            1.012,
        "ag_train_cells":    10081,
        "ag_test_cells":     2521,
        "bg_train_cells":    16000,
        "bg_test_cells":     4000,
        "total_million_tc":  54.228,
        "agc_million_tc":    1.6678,
        "bgc_million_tc":    52.5602,
        "co2e_million":      198.8541,
        "feature_importance": [
            {"feature": "Rabi_Preci",  "importance": 0.3702, "type": "climate"},
            {"feature": "DEM_mean",    "importance": 0.1050, "type": "terrain"},
            {"feature": "LST_Sept20",  "importance": 0.0550, "type": "climate"},
            {"feature": "NDVI_May25",  "importance": 0.0423, "type": "ndvi"},
            {"feature": "Rabi_LST_2",  "importance": 0.0340, "type": "climate"},
            {"feature": "NDVI_Jan25",  "importance": 0.0333, "type": "ndvi"},
            {"feature": "NDVI_Aug24",  "importance": 0.0325, "type": "ndvi"},
            {"feature": "NDVI_Feb25",  "importance": 0.0260, "type": "ndvi"},
            {"feature": "NDVI_Oct24",  "importance": 0.0260, "type": "ndvi"},
            {"feature": "NDVI_Apr25",  "importance": 0.0250, "type": "ndvi"},
        ],
        "comparison": [
            {"model":"Random Forest",  "target":"NPP","r2":0.5426,"rmse":448.597,"mae":314.795,"best":True},
            {"model":"GradientBoost",  "target":"NPP","r2":0.5250,"rmse":457.103,"mae":326.766,"best":False},
            {"model":"Random Forest",  "target":"SOC","r2":0.9665,"rmse":1.392,  "mae":1.012,  "best":True},
            {"model":"GradientBoost",  "target":"SOC","r2":0.9639,"rmse":1.445,  "mae":1.063,  "best":False},
        ]
    })
    log("Inserted model metadata document")

    client.close()
    log("MongoDB setup complete — connection closed")


# ══════════════════════════════════════════════════════════
# MAIN — runs both steps
# ══════════════════════════════════════════════════════════

if __name__ == "__main__":
    print("\n" + "="*55)
    print("  DATABASE SETUP — Carbon Stock Ludhiana")
    print("  This will take 5–10 minutes for 66k rows")
    print("="*55)

    try:
        setup_postgresql()
    except Exception as e:
        print(f"\n  ERROR in PostgreSQL setup: {e}")
        print("  Check: is pgAdmin running? Is your password correct?")
        sys.exit(1)

    try:
        setup_mongodb()
    except Exception as e:
        print(f"\n  ERROR in MongoDB setup: {e}")
        print("  Check: is MongoDB running?")
        sys.exit(1)

    print("\n" + "="*55)
    print("  ALL DONE — databases are ready!")
    print("  Now run:  python app.py")
    print("  Then open: http://localhost:5000")
    print("="*55 + "\n")

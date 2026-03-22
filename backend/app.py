"""
app.py  —  Carbon Stock Intelligence  v7
=========================================
What changed from v6:
  - /api/geojson now reads from 'all_predictions' collection
    which has all 64,545 cells with real AGC and BGC values.
  - Carbon is matched by Grid_ID (not serial id).
  - /api/summary reads from PostgreSQL district_summary table.
  - /api/carbon reads from all_predictions for the Explorer page.
"""

from flask import Flask, render_template, jsonify, request
from flask_cors import CORS
import psycopg2, psycopg2.extras
from pymongo import MongoClient
import json, os

app = Flask(
    __name__,
    template_folder=os.path.join(os.path.dirname(__file__), '..', 'frontend', 'templates'),
    static_folder   =os.path.join(os.path.dirname(__file__), '..', 'frontend', 'static'),
)
CORS(app)

PG = {
    "host":     "localhost",
    "database": "postgres",
    "user":     "postgres",
    "password": "Sathvik@6",
}
MDB_URI = "mongodb://localhost:27017/"
MDB_DB  = "carbon_stock_ludhiana"

def pg():  return psycopg2.connect(**PG)
def mdb(): return MongoClient(MDB_URI)[MDB_DB]


# ── SERVE THE WEBSITE ────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html")


# ── /api/summary ─────────────────────────────────────────────
# Reads live district totals from PostgreSQL district_summary.
# Falls back to hardcoded values if PostgreSQL is unavailable.
@app.route("/api/summary")
def api_summary():
    try:
        conn = pg()
        cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT * FROM district_summary ORDER BY id DESC LIMIT 1")
        row = cur.fetchone()
        cur.close()
        conn.close()
        if row:
            # Column names from the table use underscore, not camelCase
            d = dict(row)
            return jsonify({
                "total_million_tc": d.get("total_million_tc") or d.get("total_million_tC") or 54.228,
                "agc_million_tc":   d.get("agc_million_tc")   or d.get("agc_million_tC")   or 1.6678,
                "bgc_million_tc":   d.get("bgc_million_tc")   or d.get("bgc_million_tC")   or 52.5602,
                "agc_pct":   d.get("agc_pct",   3.08),
                "bgc_pct":   d.get("bgc_pct",   96.92),
                "ag_r2":     d.get("ag_r2",     0.5426),
                "bg_r2":     d.get("bg_r2",     0.9665),
                "ag_rmse":   d.get("ag_rmse",   448.597),
                "bg_rmse":   d.get("bg_rmse",   1.392),
                "total_cells": 66790,
                "agri_cells":  50402,
            })
    except Exception as e:
        print("PostgreSQL summary error:", e)

    # Fallback
    return jsonify({
        "total_million_tc": 54.228,
        "agc_million_tc":   1.6678,
        "bgc_million_tc":   52.5602,
        "agc_pct":   3.08,
        "bgc_pct":   96.92,
        "ag_r2":     0.5426,
        "bg_r2":     0.9665,
        "ag_rmse":   448.597,
        "bg_rmse":   1.392,
        "total_cells": 66790,
        "agri_cells":  50402,
    })


# ── /api/geojson ──────────────────────────────────────────────
# Returns PostGIS polygons with real carbon values attached.
# Carbon is loaded from MongoDB 'all_predictions' (64,545 cells)
# and matched to PostGIS cells by Grid_ID.
@app.route("/api/geojson")
def api_geojson():
    limit = min(int(request.args.get("limit", 1200)), 3000)

    # Step 1: Load all carbon values from MongoDB into a dict
    # Key = Grid_ID (integer), Value = dict of carbon properties
    carbon = {}
    try:
        db = mdb()
        for doc in db["all_predictions"].find(
            {},
            {"_id": 0, "Grid_ID": 1, "AGC_tC_ha": 1,
             "BGC_tC_ha": 1, "Predicted_NPP": 1, "Total_C_tC_ha": 1}
        ):
            gid = doc.get("Grid_ID")
            if gid is not None:
                carbon[int(gid)] = {
                    "agc": round(float(doc.get("AGC_tC_ha",    0) or 0), 4),
                    "bgc": round(float(doc.get("BGC_tC_ha",    0) or 0), 4),
                    "npp": round(float(doc.get("Predicted_NPP",0) or 0), 1),
                    "tot": round(float(doc.get("Total_C_tC_ha",0) or 0), 4),
                }
        print(f"Loaded {len(carbon):,} carbon records from MongoDB all_predictions")
    except Exception as e:
        print("MongoDB error in /api/geojson:", e)

    # Step 2: Fetch geometries from PostGIS
    try:
        conn = pg()
        cur  = conn.cursor()
        cur.execute("""
            SELECT
                ST_AsGeoJSON(geom),
                grid_id,
                agri_class,
                agnonag_m,
                dem_mean,
                slope_mean,
                sand_pct,
                clay_pct,
                bd_gcm3
            FROM grid_cells
            ORDER BY RANDOM()
            LIMIT %s
        """, (limit,))
        rows = cur.fetchall()
        cur.close()
        conn.close()
    except Exception as e:
        print("PostgreSQL error in /api/geojson:", e)
        return jsonify({"type": "FeatureCollection", "features": [], "error": str(e)})

    # Step 3: Combine geometry + carbon values
    features = []
    for row in rows:
        geom_str, gid, agri, agnonag, dem, slope, sand, clay, bd = row
        if not geom_str:
            continue

        # Match carbon by Grid_ID
        c = carbon.get(int(gid), {})

        features.append({
            "type": "Feature",
            "geometry": json.loads(geom_str),
            "properties": {
                "grid_id":    gid,
                "agri":       agri,
                "agnonag":    round(float(agnonag or 0), 4),
                "dem":        round(float(dem     or 0), 1),
                "slope":      round(float(slope   or 0), 2),
                "sand":       round(float(sand    or 0), 1),
                "clay":       round(float(clay    or 0), 1),
                "bd":         round(float(bd      or 0), 2),
                # Carbon values from MongoDB — real predictions
                "agc":        c.get("agc", 0),
                "bgc":        c.get("bgc", 0),
                "npp":        c.get("npp", 0),
                "tot":        c.get("tot", 0),
                # 1 = this cell has carbon data, 0 = no data
                "has_carbon": 1 if c else 0,
            }
        })

    return jsonify({
        "type":     "FeatureCollection",
        "features": features,
        "total":    len(features),
    })


# ── /api/ndvi ─────────────────────────────────────────────────
# Monthly NDVI values for the NDVI chart on Analytics page.
@app.route("/api/ndvi")
def api_ndvi():
    try:
        docs = list(mdb()["ndvi_summary"].find({}, {"_id": 0}).sort("sort_order", 1))
        if docs:
            return jsonify(docs)
    except Exception as e:
        print("MongoDB error in /api/ndvi:", e)

    # Fallback hardcoded values
    months  = ["Jun 24","Jul 24","Aug 24","Sep 24","Oct 24","Nov 24",
               "Dec 24","Jan 25","Feb 25","Mar 25","Apr 25","May 25"]
    vals    = [0.175, 0.246, 0.754, 0.712, 0.469, 0.193,
               0.338, 0.558, 0.714, 0.663, 0.312, 0.217]
    seasons = ["Kharif"] * 6 + ["Rabi"] * 6
    return jsonify([
        {"month": m, "median_ndvi": v, "season": s, "sort_order": i}
        for i, (m, v, s) in enumerate(zip(months, vals, seasons))
    ])


# ── /api/carbon ───────────────────────────────────────────────
# Returns carbon predictions for the Explorer page and charts.
# Now reads from all_predictions (64,545 cells).
@app.route("/api/carbon")
def api_carbon():
    page     = max(1, int(request.args.get("page", 1)))
    per_page = min(int(request.args.get("per_page", 100)), 500)
    skip     = (page - 1) * per_page

    try:
        db    = mdb()
        col   = db["all_predictions"]
        total = col.count_documents({})
        docs  = list(col.find(
            {},
            {"_id": 0, "Grid_ID": 1, "AGC_tC_ha": 1, "BGC_tC_ha": 1,
             "Predicted_NPP": 1, "Predicted_SOC": 1, "Total_C_tC_ha": 1,
             "agri_class": 1, "source": 1}
        ).skip(skip).limit(per_page))

        # Rename fields to match what the frontend expects
        records = []
        for d in docs:
            records.append({
                "cell_index":    d.get("Grid_ID", 0),
                "agc_tC_ha":     round(float(d.get("AGC_tC_ha",    0) or 0), 4),
                "bgc_tC_ha":     round(float(d.get("BGC_tC_ha",    0) or 0), 4),
                "predicted_npp": round(float(d.get("Predicted_NPP",0) or 0), 2),
                "predicted_soc": round(float(d.get("Predicted_SOC",0) or 0), 4),
                "total_c":       round(float(d.get("Total_C_tC_ha",0) or 0), 4),
                "agri_class":    d.get("agri_class", 0),
                "source":        d.get("source", ""),
            })

        return jsonify({
            "ag":       records,   # frontend expects ag list
            "bg":       records,   # same records contain both
            "ag_total": total,
            "bg_total": total,
            "page":     page,
            "per_page": per_page,
        })
    except Exception as e:
        print("MongoDB error in /api/carbon:", e)
        return jsonify({"ag": [], "bg": [], "ag_total": 0, "bg_total": 0})


# ── /api/metrics ──────────────────────────────────────────────
# Model performance metrics for the Model page.
@app.route("/api/metrics")
def api_metrics():
    try:
        doc = mdb()["model_metadata"].find_one({}, {"_id": 0})
        if doc:
            return jsonify(doc)
    except Exception as e:
        print("MongoDB error in /api/metrics:", e)

    # Fallback
    return jsonify({
        "ag_r2":   0.5426, "ag_rmse": 448.597, "ag_mae": 314.795,
        "bg_r2":   0.9665, "bg_rmse": 1.392,   "bg_mae": 1.012,
        "ag_train_cells": 10081, "ag_test_cells": 2521,
        "bg_train_cells": 16000, "bg_test_cells": 4000,
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
            {"model": "Random Forest",  "target": "NPP", "r2": 0.5426, "rmse": 448.597, "mae": 314.795, "best": True},
            {"model": "GradientBoost",  "target": "NPP", "r2": 0.5250, "rmse": 457.103, "mae": 326.766, "best": False},
            {"model": "Random Forest",  "target": "SOC", "r2": 0.9665, "rmse": 1.392,   "mae": 1.012,   "best": True},
            {"model": "GradientBoost",  "target": "SOC", "r2": 0.9639, "rmse": 1.445,   "mae": 1.063,   "best": False},
        ]
    })


# ── START SERVER ──────────────────────────────────────────────
if __name__ == "__main__":
    print("\n" + "=" * 50)
    print("  Carbon Intelligence  →  http://localhost:5000")
    print("=" * 50 + "\n")
    app.run(debug=True, port=5000)

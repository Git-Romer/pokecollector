def sort_top_movers(results, sort_by="percentage"):
    sort_field = "change_abs" if sort_by == "absolute" else "change_pct"
    return sorted(results, key=lambda x: abs(x[sort_field]), reverse=True)

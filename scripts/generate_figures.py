"""
Generate publication-ready static vector figures from run_pipeline.py's output.

The interactive dashboard (viz/) is for exploration; this script is for the
paper itself. It reads only viz/data/*.json, so every number in the figures
matches exactly what the dashboard shows (single source of truth). All text
inside the figures is in English (journal/conference figures are conventionally
English regardless of the paper's body language); the accompanying README and
report remain in Korean.

Usage:
    python scripts/generate_figures.py --data-dir viz/data --outdir figures

Outputs:
    figures/fig_umap_grid.pdf / .png   — suite x coloring-criterion residual UMAP grid
                                          (reproduces PDF Fig. 9)
    figures/fig_arrows.pdf / .png       — per-suite A->B transition arrows (reproduces PDF Fig. 10)
    figures/fig_silhouette.pdf / .png   — raw vs. residual silhouette bars with
                                          permutation-test significance markers
    figures/fig_security_outcomes.pdf/.png — condition-specific Targeted ASR + paired A→B outcomes
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

SUITE_ORDER = ["banking", "slack", "travel", "workspace"]

# 빨강/파랑/초록/보라 원색 팔레트. 대시보드(viz/app.js)와 동일 매핑을 쓴다.
VERDICT_COLOR = {
    "success_hijacked": "#E30613",   # 빨강 — task succeeded, hijacked
    "success_defended": "#0066CC",   # 진한 파랑 — task succeeded, defended
    "fail_hijacked": "#F3A6AC",      # 옅은 빨강 — task failed, hijacked
    "fail_defended": "#9FC5EA",      # 옅은 파랑 — task failed, defended
}
VERDICT_MARKER = {
    "success_hijacked": "o", "success_defended": "s", "fail_hijacked": "^", "fail_defended": "D",
}
VERDICT_LABEL = {
    "success_hijacked": "success + hijacked", "success_defended": "success + defended",
    "fail_hijacked": "fail + hijacked", "fail_defended": "fail + defended",
}
DELAY_COLOR = {"immediate": "#E30613", "delayed": "#FF8200", "none": "#0066CC"}
DELAY_MARKER = {"immediate": "o", "delayed": "^", "none": "s"}
ARROW_COLOR_NEUTRAL = "#9AA2B1"
ARROW_COLOR_NEW_HIJACK = "#E30613"
ARROW_COLOR_NEW_BLOCK = "#0072B2"

FIELD_LABEL = {
    "user_task_id": "user task\n(lower is better)",
    "hijack_tool": "hijack tool",
    "delay_bucket": "delay",
    "exposure_channel": "exposure channel",
    "verdict": "verdict",
}
CRITERION_LABEL = {"verdict": "verdict", "hijack_tool": "hijack tool", "delay_bucket": "delay"}

plt.rcParams.update({
    "figure.dpi": 150,
    "savefig.dpi": 300,
    "font.size": 8.5,
    "axes.titlesize": 9,
    "axes.titleweight": "bold",
    "axes.labelsize": 8,
    "xtick.labelsize": 7.5,
    "ytick.labelsize": 7.5,
    "legend.fontsize": 7.5,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "font.family": "DejaVu Sans",
})


def load_suites(data_dir: Path) -> dict:
    return {name: json.load(open(data_dir / f"{name}.json", encoding="utf-8"))
            for name in SUITE_ORDER if (data_dir / f"{name}.json").exists()}


def _scatter_panel(ax, cases, color_field, coord_key, color_map, marker_map=None, title=""):
    if not cases:
        ax.set_title(title)
        ax.axis("off")
        return
    for value in sorted({c[color_field] for c in cases if c[color_field] is not None}):
        pts = np.array([c[coord_key] for c in cases if c[color_field] == value])
        marker = marker_map.get(value, "o") if marker_map else "o"
        color = color_map.get(value, "#999999")
        ax.scatter(pts[:, 0], pts[:, 1], s=14, color=color,
                   marker=marker, edgecolors="white", linewidths=0.25, alpha=0.9)
    ax.set_title(title, fontsize=8.3)
    ax.set_xticks([]); ax.set_yticks([])
    for spine in ax.spines.values():
        spine.set_visible(True)
        spine.set_color("#D8DCE4")


def figure_umap_grid(suites: dict, outdir: Path):
    """Reproduces PDF Fig. 9: suite (row) x coloring criterion (column) residual
    UMAP grid, condition A only."""
    criteria = [
        ("verdict", VERDICT_COLOR, VERDICT_MARKER),
        ("hijack_tool", None, None),
        ("delay_bucket", DELAY_COLOR, DELAY_MARKER),
    ]
    present = [s for s in SUITE_ORDER if s in suites]
    fig, axes = plt.subplots(len(present), len(criteria), figsize=(3.1 * len(criteria), 2.5 * len(present)))
    if len(present) == 1:
        axes = axes.reshape(1, -1)

    for row, suite_name in enumerate(present):
        suite = suites[suite_name]
        cases_a = [c for c in suite["cases"] if c["condition"] == "A"]
        n = len(cases_a)
        for col, (field, cmap, mmap) in enumerate(criteria):
            ax = axes[row, col]
            sil = suite["validation"]["residual"].get(field)
            sil_str = f"sil={sil:.2f}" if sil is not None else "sil=n/a"
            if cmap is None:  # hijack_tool: needs a dynamic palette
                values = sorted({c[field] for c in cases_a if c[field] is not None})
                cmap_dyn = {v: plt.cm.Set2(i % 8) for i, v in enumerate(values)}
                _scatter_panel(ax, cases_a, field, "coords_residual", cmap_dyn, None,
                               title=f"{suite_name} · {CRITERION_LABEL[field]} ({sil_str})")
            else:
                _scatter_panel(ax, cases_a, field, "coords_residual", cmap, mmap,
                               title=f"{suite_name} · {CRITERION_LABEL[field]} ({sil_str})")
            if col == 0:
                ax.set_ylabel(f"UMAP-2\n(n={n})", fontsize=7)
            if row == len(present) - 1:
                ax.set_xlabel("UMAP-1", fontsize=7)

    handles = [plt.Line2D([0], [0], marker=VERDICT_MARKER[v], color="w", markerfacecolor=c,
                          markeredgecolor="white", markersize=7, label=VERDICT_LABEL[v])
               for v, c in VERDICT_COLOR.items()]
    fig.legend(handles=handles, loc="lower center", ncol=4, frameon=False,
               bbox_to_anchor=(0.5, -0.02))
    fig.suptitle("Residual-space UMAP projections by suite and coloring criterion (condition A)",
                 fontsize=9.5, y=1.01)
    fig.tight_layout(rect=[0, 0.02, 1, 0.99])
    fig.savefig(outdir / "fig_umap_grid.pdf", bbox_inches="tight")
    fig.savefig(outdir / "fig_umap_grid.png", bbox_inches="tight")
    plt.close(fig)


def figure_arrows(suites: dict, outdir: Path):
    """Reproduces PDF Fig. 10: per-suite condition A->B transition arrows in
    residual UMAP space."""
    present = [s for s in SUITE_ORDER if s in suites]
    fig, axes = plt.subplots(1, len(present), figsize=(3.4 * len(present), 3.4))
    if len(present) == 1:
        axes = [axes]

    for ax, suite_name in zip(axes, present):
        suite = suites[suite_name]
        arrows = suite["arrows"]
        n_new_hijack = sum(1 for a in arrows if a["newly_hijacked"])
        n_new_block = sum(1 for a in arrows if a["newly_blocked"])

        # matplotlib's annotate()-based arrows do not participate in autoscaling,
        # so the data limits must be set explicitly from the endpoint coordinates.
        all_pts = np.array([p for a in arrows for p in (a["from_residual"], a["to_residual"])])
        if len(all_pts):
            xpad = (all_pts[:, 0].max() - all_pts[:, 0].min()) * 0.08 + 1e-6
            ypad = (all_pts[:, 1].max() - all_pts[:, 1].min()) * 0.08 + 1e-6
            ax.set_xlim(all_pts[:, 0].min() - xpad, all_pts[:, 0].max() + xpad)
            ax.set_ylim(all_pts[:, 1].min() - ypad, all_pts[:, 1].max() + ypad)

        for a in arrows:
            p0, p1 = a["from_residual"], a["to_residual"]
            if a["newly_hijacked"]:
                color, lw, z = ARROW_COLOR_NEW_HIJACK, 1.6, 3
            elif a["newly_blocked"]:
                color, lw, z = ARROW_COLOR_NEW_BLOCK, 1.0, 2
            else:
                color, lw, z = ARROW_COLOR_NEUTRAL, 0.5, 1
            ax.annotate("", xy=p1, xytext=p0,
                        arrowprops=dict(arrowstyle="-|>", color=color, lw=lw, alpha=0.75,
                                        shrinkA=0, shrinkB=0), zorder=z)
        ax.set_title(f"{suite_name}\nnew hijacks: {n_new_hijack} · new blocks: {n_new_block}", fontsize=8.5)
        ax.set_xticks([]); ax.set_yticks([])
        for spine in ax.spines.values():
            spine.set_color("#D8DCE4")

    handles = [
        plt.Line2D([0], [0], color=ARROW_COLOR_NEW_HIJACK, lw=1.6, label="new hijack (A safe -> B hijacked)"),
        plt.Line2D([0], [0], color=ARROW_COLOR_NEW_BLOCK, lw=1.0, label="new block (A hijacked -> B safe)"),
        plt.Line2D([0], [0], color=ARROW_COLOR_NEUTRAL, lw=0.5, label="no change"),
    ]
    fig.legend(handles=handles, loc="lower center", ncol=3, frameon=False, bbox_to_anchor=(0.5, -0.08))
    fig.suptitle("Condition A -> B transition arrows in residual UMAP space", fontsize=9.5, y=1.06)
    fig.tight_layout()
    fig.savefig(outdir / "fig_arrows.pdf", bbox_inches="tight")
    fig.savefig(outdir / "fig_arrows.png", bbox_inches="tight")
    plt.close(fig)


def figure_silhouette(suites: dict, outdir: Path):
    """Grouped bar chart of raw vs. residual silhouette scores per label field.
    Bars with permutation-test p < 0.05 are marked with '*'."""
    fields = ["user_task_id", "hijack_tool", "delay_bucket", "exposure_channel", "verdict"]
    present = [s for s in SUITE_ORDER if s in suites]

    fig, axes = plt.subplots(1, len(present), figsize=(3.0 * len(present), 3.6), sharey=True)
    if len(present) == 1:
        axes = [axes]

    x = np.arange(len(fields))
    width = 0.36
    for ax, suite_name in zip(axes, present):
        val = suites[suite_name]["validation"]
        raw_scores = [val["raw"].get(f) for f in fields]
        res_scores = [val["residual"].get(f) for f in fields]
        raw_p = [val.get("raw_pvalue", {}).get(f) for f in fields]
        res_p = [val.get("residual_pvalue", {}).get(f) for f in fields]

        b1 = ax.bar(x - width / 2, [v if v is not None else 0 for v in raw_scores], width,
                    label="raw", color="#8C93A6")
        b2 = ax.bar(x + width / 2, [v if v is not None else 0 for v in res_scores], width,
                    label="residual", color="#0072B2")

        for bars, scores, pvals in [(b1, raw_scores, raw_p), (b2, res_scores, res_p)]:
            for bar, score, p in zip(bars, scores, pvals):
                if score is None:
                    continue
                star = "*" if (p is not None and p < 0.05) else ""
                y = bar.get_height()
                offset = 0.01 if y >= 0 else -0.025
                ax.text(bar.get_x() + bar.get_width() / 2, y + offset, star,
                        ha="center", va="bottom" if y >= 0 else "top", fontsize=10, color="#D55E00")

        ax.axhline(0, color="#D8DCE4", lw=0.8)
        ax.set_xticks(x)
        ax.set_xticklabels([FIELD_LABEL[f] for f in fields], rotation=35, ha="right", fontsize=6.8)
        ax.set_title(suite_name, fontsize=9)

    axes[0].set_ylabel("Silhouette coefficient")
    axes[-1].legend(loc="upper right", frameon=False)
    fig.suptitle("Raw vs. residual silhouette by label (* = permutation p < 0.05, n=500)",
                 fontsize=9.5, y=1.04)
    fig.tight_layout()
    fig.savefig(outdir / "fig_silhouette.pdf", bbox_inches="tight")
    fig.savefig(outdir / "fig_silhouette.png", bbox_inches="tight")
    plt.close(fig)



def figure_security_outcomes(suites: dict, outdir: Path):
    """Security-first summary using aligned rates and paired A->B outcomes.

    UMAP remains an exploratory drill-down.  This figure leads with direct outcome
    measures: Targeted ASR with Wilson 95% intervals, and paired transitions for
    the same user-task x injection-task cases.
    """
    present = [name for name in SUITE_ORDER if name in suites]
    if not present:
        return

    fig, (ax_asr, ax_trans) = plt.subplots(
        1, 2, figsize=(10.5, 3.8), gridspec_kw={"width_ratios": [1.05, 1.35]}
    )
    x = np.arange(len(present))
    width = 0.34

    for offset, cond, color in [(-width / 2, "A", "#D55E00"), (width / 2, "B", "#0072B2")]:
        vals, loerr, hierr = [], [], []
        for name in present:
            m = suites[name].get("security_analysis", {}).get("conditions", {}).get(cond, {})
            value = m.get("targeted_asr")
            ci = m.get("targeted_asr_ci95")
            value = 0.0 if value is None else value
            vals.append(value * 100)
            if ci:
                loerr.append((value - ci[0]) * 100)
                hierr.append((ci[1] - value) * 100)
            else:
                loerr.append(0.0)
                hierr.append(0.0)
        bars = ax_asr.bar(x + offset, vals, width, color=color, label=f"Condition {cond}", zorder=2)
        ax_asr.errorbar(
            x + offset, vals, yerr=np.array([loerr, hierr]), fmt="none",
            ecolor="#343A46", elinewidth=0.8, capsize=2.5, zorder=3,
        )
        for bar, value in zip(bars, vals):
            ax_asr.text(bar.get_x() + bar.get_width()/2, value + 2.0, f"{value:.1f}%",
                        ha="center", va="bottom", fontsize=7)

    ax_asr.set_xticks(x, present)
    ax_asr.set_ylabel("Targeted ASR (%)")
    ax_asr.set_ylim(0, 100)
    ax_asr.set_title("Attacker-goal success by condition")
    ax_asr.grid(axis="y", color="#E8EBF0", linewidth=0.7, zorder=0)
    ax_asr.legend(frameon=False, loc="upper right")

    transition_order = ["blocked", "regressed", "still_hijacked", "still_safe"]
    transition_label = {
        "blocked": "blocked by B", "regressed": "regressed under B",
        "still_hijacked": "still hijacked", "still_safe": "still safe",
    }
    transition_color = {
        "blocked": "#009E73", "regressed": "#D55E00",
        "still_hijacked": "#CC79A7", "still_safe": "#0072B2",
    }
    left = np.zeros(len(present))
    for key in transition_order:
        vals = []
        for name in present:
            pair = suites[name].get("security_analysis", {}).get("paired_defense") or {}
            vals.append((pair.get("security_transitions") or {}).get(key, 0))
        ax_trans.barh(present, vals, left=left, color=transition_color[key], label=transition_label[key])
        for yi, (base, value) in enumerate(zip(left, vals)):
            if value >= 2:
                ax_trans.text(base + value / 2, yi, str(value), ha="center", va="center",
                              fontsize=7, color="white", fontweight="bold")
        left += np.array(vals, dtype=float)

    ax_trans.set_xlabel("Paired cases (count)")
    ax_trans.set_title("Same-case A→B security transitions")
    ax_trans.grid(axis="x", color="#EEF0F4", linewidth=0.6, zorder=0)
    ax_trans.legend(frameon=False, fontsize=7, ncol=2, loc="upper center", bbox_to_anchor=(0.5, -0.17))

    fig.suptitle(
        "DojoScope security outcomes — synthetic sample only (not an AgentDojo benchmark claim)",
        fontsize=10, fontweight="bold",
    )
    fig.tight_layout(rect=[0, 0.08, 1, 0.92])
    fig.savefig(outdir / "fig_security_outcomes.pdf", bbox_inches="tight")
    fig.savefig(outdir / "fig_security_outcomes.png", bbox_inches="tight")
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data-dir", default="viz/data", help="output directory written by run_pipeline.py or add_data.py")
    parser.add_argument("--outdir", default="figures", help="directory to write figures into")
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    suites = load_suites(data_dir)
    if not suites:
        raise SystemExit(f"No suite JSON found under {data_dir}. Run run_pipeline.py first.")

    figure_umap_grid(suites, outdir)
    figure_arrows(suites, outdir)
    figure_silhouette(suites, outdir)
    figure_security_outcomes(suites, outdir)

    print(f"Done: {outdir}/fig_umap_grid.{{pdf,png}}, fig_arrows.{{pdf,png}}, fig_silhouette.{{pdf,png}}, fig_security_outcomes.{{pdf,png}}")


if __name__ == "__main__":
    main()

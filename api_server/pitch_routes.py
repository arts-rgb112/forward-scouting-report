"""Production composition for the additive, stored-source pitch APIs."""
from collections.abc import Callable, Collection
from functools import lru_cache
from pathlib import Path
from threading import RLock

from fastapi import APIRouter

from api_server.box_subregion_contract import BoxContext
from api_server.box_subregion_router import create_box_subregion_router
from api_server.native_body_part_router import create_native_body_part_router
from api_server.native_pitch_events_contract import build_native_pitch_envelope
from api_server.native_pitch_events_router import create_native_pitch_events_router
from api_server.native_pitch_v2_contract import build_native_pitch_v2_envelope
from api_server.native_pitch_v2_router import create_native_pitch_v2_router
from api_server.full_activity_display_core import build_full_activity_display_envelope
from api_server.full_activity_display_router import create_full_activity_display_router
from api_server.pitch_source_provider import ResolvedPitchPlayer
from api_server.schemas import FullActivityHeatmapEnvelope


def create_pitch_router(
    data_root: Path,
    player_lookup: Callable[[BoxContext], ResolvedPitchPlayer | None],
    supported_seasons: Callable[[], Collection[str]],
    *,
    full_heat_provider: Callable[[BoxContext], FullActivityHeatmapEnvelope | None] | None = None,
) -> APIRouter:
    source_lock = RLock()
    # Import/instantiate within the endpoint provider boundary: a broken pitch
    # artifact must fail these routes, not disable existing leaderboards/health.
    @lru_cache(maxsize=1)
    def source():
        from api_server.pitch_snapshot_provider import PitchSnapshotProvider

        return PitchSnapshotProvider(data_root, player_lookup)

    def native(context, include_penalties):
        # These providers run in sync-route worker threads, not the event loop.
        # Serialize heavy decoding/build work and simultaneous cold construction.
        with source_lock:
            selected = source().native_sources(context)
            if selected is None:
                return None
            return build_native_pitch_envelope(context, selected, include_penalties=include_penalties)

    def native_v2(context, include_penalties):
        # v2 has a corrected terminal-coordinate policy but reads the exact
        # same already-selected native snapshot as v1.
        with source_lock:
            selected = source().native_sources(context)
            if selected is None:
                return None
            return build_native_pitch_v2_envelope(context, selected, include_penalties=include_penalties)

    def full_activity_display(context):
        if full_heat_provider is None:
            raise ValueError("Full-activity display source was not configured")
        with source_lock:
            selected = source().full_activity_sources(context)
            if selected is None:
                return None
            published = full_heat_provider(context.model_copy(deep=True))
            if published is None:
                return None
            published_context = published.context.model_dump()
            if any(published_context.get(field) != value for field, value in context.model_dump().items()):
                raise ValueError("Published full-activity context differs from selected raw context")
            return build_full_activity_display_envelope(context, selected, published.data.model_dump())

    def box(context):
        with source_lock:
            return source().box(context)

    def body(context, include_penalties):
        with source_lock:
            return source().body_parts(context, include_penalties)

    router = APIRouter()
    router.include_router(create_box_subregion_router(box, supported_seasons))
    router.include_router(create_native_body_part_router(body, supported_seasons))
    router.include_router(create_native_pitch_events_router(native, supported_seasons))
    router.include_router(create_native_pitch_v2_router(native_v2, supported_seasons))
    router.include_router(create_full_activity_display_router(full_activity_display, supported_seasons))
    return router

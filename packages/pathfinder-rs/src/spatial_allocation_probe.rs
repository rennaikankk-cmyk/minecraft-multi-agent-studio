//! Test-binary-only allocator accounting, scoped to the current test thread.
use crate::world_mirror::{ApplyOutcome, WorldMirror};
use crate::world_mirror_protocol::{MirrorMessage, SectionPayload};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::time::Instant;

thread_local! { static ALLOCATED: Cell<Option<usize>> = const { Cell::new(None) }; }
struct ProbeAllocator;
fn record(size: usize) {
    let _ = ALLOCATED.try_with(|value| {
        if let Some(n) = value.get() {
            value.set(Some(n + size));
        }
    });
}
unsafe impl GlobalAlloc for ProbeAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        System.alloc(layout)
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        System.alloc_zeroed(layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        record(new_size);
        System.realloc(ptr, layout, new_size)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout);
    }
}
#[global_allocator]
static ALLOCATOR: ProbeAllocator = ProbeAllocator;

#[test]
fn snapshot_allocation_is_chunk_pointer_copy_not_voxel_clone() {
    let mut mirror = WorldMirror::new(1, 1);
    mirror.apply_message(
        MirrorMessage::RegistryTable {
            revision: 1,
            masks: vec![1, 4],
            minecraft_version: None,
            server_profile_id: None,
        },
        1,
    );
    let mut loaded = 0;
    for target in [1, 81, 289] {
        while loaded < target {
            let chunk = (loaded, 0);
            mirror.apply_message(MirrorMessage::ChunkBegin { chunk }, 2);
            for section_y in -4..20 {
                mirror.apply_message(
                    MirrorMessage::SectionData {
                        chunk,
                        payload: SectionPayload::Data {
                            section_y,
                            palette_indices: vec![0; 4096].into_boxed_slice(),
                            palette_entries: vec![4],
                        },
                    },
                    3,
                );
            }
            assert_eq!(
                mirror.apply_message(MirrorMessage::ChunkCommit { chunk }, 4),
                ApplyOutcome::Applied
            );
            loaded += 1;
        }
        let mut durations = Vec::with_capacity(200);
        let mut allocations = Vec::with_capacity(200);
        for _ in 0..200 {
            ALLOCATED.with(|v| v.set(Some(0)));
            let began = Instant::now();
            let snapshot = mirror.snapshot_handle();
            let elapsed_us = began.elapsed().as_secs_f64() * 1_000_000.0;
            let allocated = ALLOCATED.with(|v| v.replace(None).unwrap());
            std::hint::black_box(&snapshot);
            drop(snapshot);
            durations.push(elapsed_us);
            allocations.push(allocated);
        }
        durations.sort_by(f64::total_cmp);
        let allocated = *allocations.iter().max().unwrap();
        assert!(
            allocated < target as usize * 128 + 256,
            "snapshot must copy pointers, not section data"
        );
        println!("D3_SNAPSHOT_ALLOCATION {{\"chunks\":{target},\"dataSections\":{},\"samples\":200,\"allocatedBytesMax\":{allocated},\"p50Us\":{},\"p99Us\":{}}}", target * 24, durations[100], durations[198]);
    }
}

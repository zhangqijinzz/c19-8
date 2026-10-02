import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStarterDocument } from '../src/domain';
import type { LayoutRepository } from '../src/repository';
import type { LayoutDocument } from '../src/types';
import { ExpoSketchViewModel } from '../src/viewModel';

const fakeRepository = (initial: LayoutDocument | null = null): LayoutRepository => ({
  load: vi.fn(async () => initial ?? createStarterDocument()),
  save: vi.fn(async (_document) => {}),
});

// 每一笔 save 都挂起，测试通过 gates 手动放行，用来模拟慢写/乱序场景
const gatedRepository = () => {
  const saves: LayoutDocument[] = [];
  const gates: Array<() => void> = [];
  const repository: LayoutRepository = {
    load: vi.fn(async () => createStarterDocument()),
    save: vi.fn((document: LayoutDocument) => {
      saves.push(document);
      return new Promise<void>((resolve) => gates.push(resolve));
    }),
  };
  return { repository, saves, gates };
};

const stagePosition = (document: LayoutDocument) => {
  const stage = document.elements.find((element) => element.id === 'stage-1');
  return stage ? { x: stage.x, y: stage.y } : null;
};

describe('ExpoSketchViewModel', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('initializes and updates the selected layout', async () => {
    const repository = fakeRepository();
    const vm = new ExpoSketchViewModel(repository);
    await vm.initialize();
    expect(vm.state.phase).toBe('ready');
    const count = vm.state.document.elements.length;
    vm.addElement('booth');
    expect(vm.state.document.elements).toHaveLength(count + 1);
    expect(vm.state.selectedId).toContain('booth-');
  });

  it('updates analysis immediately after moving an element into an overlap', () => {
    const vm = new ExpoSketchViewModel(fakeRepository());
    vm.moveElement('stage-1', 4.5, 2.5);
    expect(vm.state.analysis.overlaps.length).toBeGreaterThan(0);
  });

  it('recovers the example if repository loading fails', async () => {
    const repository: LayoutRepository = { load: vi.fn(async () => { throw new Error('bad storage'); }), save: vi.fn(async () => {}) };
    const vm = new ExpoSketchViewModel(repository);
    await vm.initialize();
    expect(vm.state.phase).toBe('error');
    expect(vm.state.document.title).toContain('春日创意市集');
  });

  it('shows a save error without dropping the working document', async () => {
    vi.useFakeTimers();
    const repository: LayoutRepository = { load: vi.fn(async () => createStarterDocument()), save: vi.fn(async () => { throw new Error('quota'); }) };
    const vm = new ExpoSketchViewModel(repository, { saveDelayMs: 100, saveRetryDelayMs: 60_000 });
    await vm.initialize();
    vm.addElement('stage');
    await vi.advanceTimersByTimeAsync(100);
    expect(vm.state.document.elements.some((element) => element.kind === 'stage' && element.id.startsWith('stage-'))).toBe(true);
    expect(vm.state.notice.tone).toBe('error');
  });

  it('ignores invalid dimensions instead of corrupting the working selection', () => {
    const vm = new ExpoSketchViewModel(fakeRepository());
    const before = vm.state.document.elements[0].width;
    vm.resizeSelected(0, 0);
    expect(vm.state.document.elements[0].width).toBe(before);
  });

  it('debounces a continuous drag into a single save with the final position', async () => {
    vi.useFakeTimers();
    const repository = fakeRepository();
    const vm = new ExpoSketchViewModel(repository, { saveDelayMs: 400 });
    for (let step = 0; step < 10; step += 1) {
      vm.moveElement('stage-1', 5 + step, 3);
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(repository.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(stagePosition(vi.mocked(repository.save).mock.calls[0][0])).toEqual({ x: 14, y: 3 });
  });

  it('serializes saves so edits made during an in-flight write are persisted afterwards', async () => {
    vi.useFakeTimers();
    const { repository, saves, gates } = gatedRepository();
    const vm = new ExpoSketchViewModel(repository, { saveDelayMs: 100 });
    vm.moveElement('stage-1', 6, 2);
    await vi.advanceTimersByTimeAsync(100);
    expect(saves).toHaveLength(1);
    vm.moveElement('stage-1', 9, 2);
    vm.moveElement('stage-1', 12, 2);
    await vi.advanceTimersByTimeAsync(500);
    expect(saves).toHaveLength(1);
    gates[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toHaveLength(2);
    gates[1]();
    await vi.advanceTimersByTimeAsync(0);
    expect(stagePosition(saves[saves.length - 1])).toEqual({ x: 12, y: 2 });
    expect(vm.state.lastSavedAt).not.toBeNull();
  });

  it('updates the saved timestamp only when the persisted content matches the latest state', async () => {
    vi.useFakeTimers();
    const { repository, gates } = gatedRepository();
    const vm = new ExpoSketchViewModel(repository, { saveDelayMs: 100 });
    vm.moveElement('stage-1', 6, 2);
    await vi.advanceTimersByTimeAsync(100);
    vm.moveElement('stage-1', 9, 2);
    gates[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(vm.state.lastSavedAt).toBeNull();
    expect(gates).toHaveLength(2);
    gates[1]();
    await vi.advanceTimersByTimeAsync(0);
    expect(vm.state.lastSavedAt).not.toBeNull();
  });

  it('retries a failed save later without losing the edits', async () => {
    vi.useFakeTimers();
    const saves: LayoutDocument[] = [];
    let attempts = 0;
    const repository: LayoutRepository = {
      load: vi.fn(async () => createStarterDocument()),
      save: vi.fn(async (document: LayoutDocument) => {
        attempts += 1;
        if (attempts === 1) throw new Error('quota');
        saves.push(document);
      }),
    };
    const vm = new ExpoSketchViewModel(repository, { saveDelayMs: 100, saveRetryDelayMs: 1000 });
    vm.moveElement('stage-1', 6, 2);
    await vi.advanceTimersByTimeAsync(100);
    expect(vm.state.notice.tone).toBe('error');
    expect(vm.state.lastSavedAt).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves).toHaveLength(1);
    expect(stagePosition(saves[0])).toEqual({ x: 6, y: 2 });
    expect(vm.state.lastSavedAt).not.toBeNull();
  });
});

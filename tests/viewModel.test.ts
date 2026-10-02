import { describe, expect, it, vi } from 'vitest';
import { createStarterDocument } from '../src/domain';
import type { LayoutRepository } from '../src/repository';
import type { LayoutDocument } from '../src/types';
import { ExpoSketchViewModel } from '../src/viewModel';

const fakeRepository = (initial: LayoutDocument | null = null): LayoutRepository => ({
  load: vi.fn(async () => initial ?? createStarterDocument()),
  save: vi.fn(async (_document) => {}),
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const deferredRepository = () => {
  const saves: LayoutDocument[] = [];
  const resolvers: Array<() => void> = [];
  const repository: LayoutRepository = {
    load: vi.fn(async () => createStarterDocument()),
    save: vi.fn((document: LayoutDocument) => new Promise<void>((resolve) => { saves.push(document); resolvers.push(resolve); })),
  };
  return { repository, saves, resolvers };
};

describe('ExpoSketchViewModel', () => {
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
    const repository: LayoutRepository = { load: vi.fn(async () => createStarterDocument()), save: vi.fn(async () => { throw new Error('quota'); }) };
    const vm = new ExpoSketchViewModel(repository);
    await vm.initialize();
    vm.addElement('stage');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vm.state.document.elements.some((element) => element.kind === 'stage' && element.id.startsWith('stage-'))).toBe(true);
    expect(vm.state.notice.tone).toBe('error');
  });

  it('ignores invalid dimensions instead of corrupting the working selection', () => {
    const vm = new ExpoSketchViewModel(fakeRepository());
    const before = vm.state.document.elements[0].width;
    vm.resizeSelected(0, 0);
    expect(vm.state.document.elements[0].width).toBe(before);
  });

  it('debounces persistence while dragging and saves only the latest position', async () => {
    vi.useFakeTimers();
    try {
      const repository = fakeRepository();
      const vm = new ExpoSketchViewModel(repository);
      vm.moveElement('stage-1', 10, 10);
      vm.moveElement('stage-1', 20, 20);
      vm.moveElement('stage-1', 30, 30);
      expect(repository.save).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(400);
      expect(repository.save).toHaveBeenCalledTimes(1);
      const saved = vi.mocked(repository.save).mock.calls[0][0];
      expect(saved.elements.find((element) => element.id === 'stage-1')).toMatchObject({ x: 30, y: 30 });
      expect(vm.state.lastSavedAt).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes the pending save immediately when the drag ends', async () => {
    vi.useFakeTimers();
    try {
      const repository = fakeRepository();
      const vm = new ExpoSketchViewModel(repository);
      vm.moveElement('stage-1', 12, 8);
      vm.endDrag();
      await vi.advanceTimersByTimeAsync(0);
      expect(repository.save).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(repository.save).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes saves so an earlier slow write cannot overwrite a newer state', async () => {
    const { repository, saves, resolvers } = deferredRepository();
    const vm = new ExpoSketchViewModel(repository);
    vm.moveElement('stage-1', 5, 5);
    vm.endDrag();
    expect(repository.save).toHaveBeenCalledTimes(1);

    vm.moveElement('stage-1', 9, 9);
    vm.endDrag();
    expect(repository.save).toHaveBeenCalledTimes(1);

    resolvers[0]();
    await tick();
    expect(repository.save).toHaveBeenCalledTimes(2);
    resolvers[1]();
    await tick();

    expect(saves).toHaveLength(2);
    expect(saves[0].elements.find((element) => element.id === 'stage-1')).toMatchObject({ x: 5, y: 5 });
    expect(saves[1].elements.find((element) => element.id === 'stage-1')).toMatchObject({ x: 9, y: 9 });
    expect(vm.state.lastSavedAt).not.toBeNull();
  });

  it('updates lastSavedAt only after the newest state has actually been written', async () => {
    const { repository, resolvers } = deferredRepository();
    const vm = new ExpoSketchViewModel(repository);
    vm.moveElement('stage-1', 5, 5);
    vm.endDrag();
    vm.moveElement('stage-1', 9, 9);
    vm.endDrag();

    resolvers[0]();
    await tick();
    expect(repository.save).toHaveBeenCalledTimes(2);
    expect(vm.state.lastSavedAt).toBeNull();

    resolvers[1]();
    await tick();
    expect(vm.state.lastSavedAt).not.toBeNull();
  });

  it('keeps the change dirty after a save failure and retries on the next edit', async () => {
    let failures = 1;
    const repository: LayoutRepository = {
      load: vi.fn(async () => createStarterDocument()),
      save: vi.fn(async () => { if (failures > 0) { failures -= 1; throw new Error('quota'); } }),
    };
    const vm = new ExpoSketchViewModel(repository);
    vm.addElement('booth');
    await tick();
    expect(vm.state.notice.tone).toBe('error');
    expect(vm.state.lastSavedAt).toBeNull();

    vm.moveElement('stage-1', 7, 7);
    vm.endDrag();
    await tick();
    expect(repository.save).toHaveBeenCalledTimes(2);
    expect(vm.state.lastSavedAt).not.toBeNull();
  });
});

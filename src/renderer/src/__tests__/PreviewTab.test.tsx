// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { PreviewTab } from '../components/PreviewTab';

// 把 MonacoCodeEditor 替换成可控桩：渲染一个按钮，onChange 把值回传给 PreviewTab，
// 从而精确控制 dirty 状态（无需在 jsdom 下驱动真实 Monaco）。
vi.mock('../components/editor/MonacoCodeEditor', () => ({
  MonacoCodeEditor: ({ onChange }: any) => {
    // 用按钮直接触发 onChange 使 dirty（不依赖 jsdom 下驱动真实编辑器输入）。
    return <button data-testid="make-dirty" onClick={() => onChange('edited content')}>make dirty</button>;
  },
}));

function makePi(content = 'hello world') {
  return {
    fsReadFile: vi.fn().mockResolvedValue({ content, isImage: false, isBinary: false }),
    fsWriteFile: vi.fn().mockResolvedValue(undefined),
    fsOpenWithSystem: vi.fn().mockResolvedValue(true),
    fsWatchFile: vi.fn().mockReturnValue(() => {}),
  };
}

describe('PreviewTab 关闭确认（dirty 拦截）', () => {
  beforeEach(() => {
    (window as any).pi = makePi();
  });

  it('非 dirty 时：点 TabBar × 直接关闭（调 onClose，不弹确认）', async () => {
    const onClose = vi.fn();
    const register = vi.fn();
    render(
      <PreviewTab
        tabId="p1"
        root="C:\\work"
        path="README.md"
        active
        onClose={onClose}
        onRegisterCloseGuard={register}
      />,
    );
    // 等待文件加载完成（kind 变为 code）
    await waitFor(() => expect(screen.getByTestId('make-dirty')).toBeInTheDocument());
    // 挂载时向 CenterPane 注册了关闭拦截器
    expect(register).toHaveBeenCalledWith('p1', expect.any(Function));

    // 模拟 TabBar ×：调用注册的 guard（非 dirty 应直接 onClose）
    const guard = register.mock.calls[register.mock.calls.length - 1][1];
    act(() => { guard(); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('文件有未保存的改动')).toBeNull();
  });

  it('dirty 时：点 × 弹确认框，确认后关闭并调用 onClose（不静默丢弃）', async () => {
    const onClose = vi.fn();
    const register = vi.fn();
    render(
      <PreviewTab
        tabId="p1"
        root="C:\\work"
        path="README.md"
        active
        onClose={onClose}
        onRegisterCloseGuard={register}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('make-dirty')).toBeInTheDocument());

    // 编辑内容 → 触发 onChange 使 dirty（内容 !== initialContent）
    const editor = screen.getByTestId('make-dirty') as HTMLButtonElement;
    fireEvent.click(editor);
    await waitFor(() => expect(screen.getByText('●')).toBeInTheDocument()); // dirty 标记

    // 模拟 TabBar ×：调用 guard → 应弹确认框而非直接关
    const guard = register.mock.calls[register.mock.calls.length - 1][1];
    act(() => { guard(); });
    expect(onClose).not.toHaveBeenCalled();
    const dialog = await screen.findByText('文件有未保存的改动', { exact: false });
    expect(dialog).toBeInTheDocument();

    // 点击「关闭并丢弃」→ 真正关闭
    const confirmBtn = dialog.closest('.confirm-dialog')!.querySelector('.btn-danger')!;
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('dirty 时：确认框「继续编辑」可取消关闭', async () => {
    const onClose = vi.fn();
    const register = vi.fn();
    render(
      <PreviewTab
        tabId="p1"
        root="C:\\work"
        path="README.md"
        active
        onClose={onClose}
        onRegisterCloseGuard={register}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('make-dirty')).toBeInTheDocument());
    const editor = screen.getByTestId('make-dirty') as HTMLButtonElement;
    fireEvent.click(editor);
    await waitFor(() => expect(screen.getByText('●')).toBeInTheDocument());

    const guard = register.mock.calls[register.mock.calls.length - 1][1];
    act(() => { guard(); });
    const dialog = await screen.findByText('文件有未保存的改动', { exact: false });
    const cancelBtn = dialog.closest('.confirm-dialog')!.querySelector('.btn')!; // 取消按钮
    fireEvent.click(cancelBtn);
    await waitFor(() => expect(screen.queryByText('文件有未保存的改动')).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('PreviewTab 文件被删除（notFound → 上报 + 提示）', () => {
  it('fsReadFile 返回 notFound → 上报 onDeletedChange(true) + 内容区显示提示', async () => {
    (window as any).pi = {
      fsReadFile: vi.fn().mockResolvedValue({ notFound: true, content: '', isImage: false, isBinary: false }),
      fsWriteFile: vi.fn().mockResolvedValue(undefined),
      fsOpenWithSystem: vi.fn().mockResolvedValue(true),
      fsWatchFile: vi.fn().mockReturnValue(() => {}),
    };
    const onDeletedChange = vi.fn();
    render(
      <PreviewTab
        tabId="p1"
        root="C:\\work"
        path="deleted.txt"
        active
        onClose={vi.fn()}
        onRegisterCloseGuard={vi.fn()}
        onDeletedChange={onDeletedChange}
      />,
    );
    // 上报 deleted = true（TabBar 据此渲染红字+删除线）
    await waitFor(() => expect(onDeletedChange).toHaveBeenCalledWith(true));
    // 内容区显示「文件已被删除」提示（header drawer-error + body preview-error 两处均渲染）
    const errs = await screen.findAllByText('文件已被删除');
    expect(errs.length).toBeGreaterThanOrEqual(1);
  });
});

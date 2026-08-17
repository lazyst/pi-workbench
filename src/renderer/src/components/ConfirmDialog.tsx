import * as AlertDialog from '@radix-ui/react-alert-dialog';

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

// 弹窗生命周期由父组件挂载/卸载控制，故 open 恒为 true，无需内部状态。
export function ConfirmDialog({ title, message, confirmLabel = '删除', cancelLabel = '取消', onConfirm, onCancel }: Props) {
  return (
    <AlertDialog.Root open>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="confirm-overlay" />
        <AlertDialog.Content
          className="confirm-dialog"
          onEscapeKeyDown={onCancel}
        >
          <AlertDialog.Title className="confirm-title">{title}</AlertDialog.Title>
          <AlertDialog.Description className="confirm-message">{message}</AlertDialog.Description>
          <div className="confirm-actions">
            <button type="button" className="btn" onClick={onCancel}>{cancelLabel}</button>
            <button type="button" className="btn btn-danger" onClick={onConfirm}>{confirmLabel}</button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

"use client";

import type { ReactNode } from "react";
import { X } from "lucide-react";

interface ModalProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
}

export function Modal({ title, children, onClose }: ModalProps) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon-button" type="button" onClick={onClose} title="關閉">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}


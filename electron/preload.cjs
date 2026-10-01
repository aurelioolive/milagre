const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("milagre", {
  listSkills: (projectPath) => ipcRenderer.invoke("skills:list", projectPath),
  getCurrentProject: () => ipcRenderer.invoke("project:current"),
  openProject: () => ipcRenderer.invoke("project:open"),
  saveProject: (projectPath, state) => ipcRenderer.invoke("project:save", projectPath, state),
  sendToAgent: (request) => ipcRenderer.invoke("agent:send", request),
  cancelAgent: () => ipcRenderer.invoke("agent:cancel"),
});

import { OWNER_PAGE_CLASSES as CLASS, OWNER_PAGE_IDS as ID } from "./element-ids.js";
import { HARNESS_DIRECTORY } from "../workspace-layout.js";

/**
 * The sidebar's behaviour: read `GET /api/projects`, show what the owner may work in, and let a
 * reader pick one. Selecting a project is the only way this page names a project, which is why
 * there is no project-id field to type into — the catalog is what the tenant connected plus the
 * harness entry, and a typed id could only ever name something outside it.
 *
 * The list holds two kinds of entry. A connected repository shows its repository URL; the harness
 * entry shows the checkout it selects and is not counted as a connection, because there is nothing
 * to authorize and nothing to clone for it. An empty catalog selects nothing, so the conversation
 * says to select a project rather than staying blank.
 *
 * Selection is also a boundary. It bumps `page.selection` and stops any turn still streaming, so
 * frames belonging to the project a reader just left cannot reach the conversation they switched
 * to. Connecting a repository and driving the GitHub device authorization live here too, and
 * neither has a field for a token: the page shows GitHub's verification link and code, and the
 * credential goes from GitHub to the workspace (ADR-0039).
 */
export const OWNER_PAGE_SCRIPT_PROJECTS = `
  function renderConnection(status) {
    var link = node("${ID.githubVerificationLink}");
    if (!status || typeof status.state !== "string") {
      setText("${ID.githubState}", "unknown");
      setText("${ID.githubDetail}", "");
      return;
    }
    setText("${ID.githubState}", status.state);
    var detail = "";
    if (status.state === "connected") {
      detail = text(status.login) + " (" + text(status.source) + ")";
    } else if (status.state === "awaiting-authorization") {
      detail = "enter code " + text(status.userCode) + " at GitHub";
    } else if (status.state === "reconnect-required") {
      detail = text(status.reason);
    } else if (status.state === "tooling-missing") {
      detail = "the workspace has no gh command";
    }
    setText("${ID.githubDetail}", detail);
    if (link !== null) {
      var uri = status.state === "awaiting-authorization" ? text(status.verificationUri) : "";
      link.textContent = uri;
      if (uri === "") {
        link.removeAttribute("href");
      } else {
        link.setAttribute("href", uri);
      }
    }
  }

  function markSelected(projectId) {
    var buttons = document.querySelectorAll(".${CLASS.projectButton}");
    for (var index = 0; index < buttons.length; index += 1) {
      var button = buttons[index];
      var selected = button.getAttribute("data-project-id") === projectId;
      button.className = selected
        ? "${CLASS.projectButton} ${CLASS.selectedProject}"
        : "${CLASS.projectButton}";
      button.setAttribute("aria-current", selected ? "true" : "false");
    }
  }

  function selectProject(project) {
    page.selection += 1;
    cancelActiveTurn();
    page.projectId = project.id;
    page.projectName = text(project.displayName);
    page.freshArmed = false;
    setText("${ID.conversationProject}", page.projectName);
    setText("${ID.turnState}", "");
    setText("${ID.freshThreadStatus}", "");
    markSelected(project.id);
    clearConversation();
    return loadThread(false);
  }

  function projectButton(project) {
    var button = element("button", "${CLASS.projectButton}");
    button.type = "button";
    button.setAttribute("data-project-id", project.id);
    button.textContent = text(project.displayName);
    var repository = element("span", "repo");
    repository.textContent = project.kind === "harness"
      ? "${HARNESS_DIRECTORY}"
      : text(project.repositoryUrl);
    button.appendChild(repository);
    button.addEventListener("click", function () {
      void selectProject(project);
    });
    return button;
  }

  function renderProjects(result) {
    var payload = result.payload;
    var list = node("${ID.projectList}");
    if (!payload || payload.ok !== true || !Array.isArray(payload.projects) || list === null) {
      setText("${ID.projectListStatus}", problemText(payload, result.status));
      return;
    }
    renderConnection(payload.github);
    list.textContent = "";
    for (var index = 0; index < payload.projects.length; index += 1) {
      var item = element("li");
      item.appendChild(projectButton(payload.projects[index]));
      list.appendChild(item);
    }
    var connected = 0;
    for (var counted = 0; counted < payload.projects.length; counted += 1) {
      if (payload.projects[counted].kind !== "harness") {
        connected += 1;
      }
    }
    setText(
      "${ID.projectListStatus}",
      connected === 0 ? "no repository connected yet" : connected + " connected",
    );
    if (payload.projects.length === 0) {
      setText("${ID.conversationState}", "select a project first");
      return;
    }
    if (page.projectId === null) {
      void selectProject(payload.projects[0]);
    } else {
      markSelected(page.projectId);
    }
  }

  async function loadProjects() {
    clearError();
    setText("${ID.projectListStatus}", "reading");
    try {
      renderProjects(await call("GET", "/api/projects"));
    } catch (error) {
      setText("${ID.projectListStatus}", "request failed");
      reportError("the project list request", error);
    }
  }

  async function connectProject() {
    clearError();
    var repositoryUrl = inputValue("${ID.connectRepositoryInput}");
    if (repositoryUrl === "") {
      setText("${ID.connectStatus}", "enter a repository url first");
      return;
    }
    setText("${ID.connectStatus}", "connecting");
    try {
      var result = await call("POST", "/api/projects/connect", { repositoryUrl: repositoryUrl });
      var payload = result.payload;
      if (payload && payload.github) {
        renderConnection(payload.github);
      }
      if (!payload || payload.ok !== true) {
        setText("${ID.connectStatus}", problemText(payload, result.status));
        return;
      }
      setText(
        "${ID.connectStatus}",
        payload.alreadyConnected ? "already connected" : "connected",
      );
      await loadProjects();
    } catch (error) {
      setText("${ID.connectStatus}", "request failed");
      reportError("the connect request", error);
    }
  }

  async function authorizeGitHub(path) {
    clearError();
    setText("${ID.githubDetail}", "asking GitHub");
    try {
      var result = await call("POST", path, {});
      var payload = result.payload;
      if (!payload || payload.ok !== true) {
        setText("${ID.githubState}", problemText(payload, result.status));
        return;
      }
      renderConnection(payload.github);
    } catch (error) {
      setText("${ID.githubState}", "request failed");
      reportError("the GitHub authorization request", error);
    }
  }

  function toggleSidebar() {
    var layout = node("${ID.layout}");
    var toggle = node("${ID.sidebarToggle}");
    if (layout === null || toggle === null) {
      return;
    }
    var collapsed = layout.className === "sidebar-collapsed";
    layout.className = collapsed ? "" : "sidebar-collapsed";
    toggle.setAttribute("aria-expanded", collapsed ? "true" : "false");
    toggle.textContent = collapsed ? "Hide" : "Show projects";
  }
`;

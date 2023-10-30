import * as vscode from "vscode"
import { Utils } from "vscode-uri"
import {
    Fragment,
    PromptTemplate,
    groupBy,
    rootFragment,
    templateGroup,
} from "coarch-core"
import { ExtensionState } from "./state"
import { saveAllTextDocuments } from "./fs"

type TemplateQuickPickItem = {
    template?: PromptTemplate
    action?: "create" | "discussions"
} & vscode.QuickPickItem

export function activateFragmentCommands(state: ExtensionState) {
    const { context } = state
    const { subscriptions } = context

    const checkSaved = async () => {
        if (vscode.workspace.textDocuments.some((doc) => doc.isDirty)) {
            vscode.window.showErrorMessage(
                "GPTool cancelled. Please save all files before running GPTools."
            )
            return false
        }

        await state.parseWorkspace()

        return true
    }

    const pickTemplate = async (
        fragment: Fragment,
        options?: {
            filter?: (p: PromptTemplate) => boolean
        }
    ) => {
        const { filter = () => true } = options || {}
        const templates = fragment.applicableTemplates().filter(filter)

        const picked = await vscode.window.showQuickPick(
            templatesToQuickPickItems(templates),
            {
                title: `Pick a GPTool to apply to ${fragment.title}`,
            }
        )
        if (picked?.action === "create") {
            vscode.commands.executeCommand("coarch.prompt.create")
            return undefined
        } else if (picked?.action === "discussions") {
            vscode.env.openExternal(
                vscode.Uri.parse(
                    "https://github.com/microsoft/gptools/discussions"
                )
            )
            return undefined
        } else return (picked as TemplateQuickPickItem)?.template
    }

    const fragmentExecute = async (
        fragment: Fragment,
        label: string,
        templateId: string
    ) => {
        if (!fragment) return

        fragment = state.project.fragmentByFullId[fragment.fullId] ?? fragment
        const template = fragment.file.project.getTemplate(templateId)

        await state.cancelAiRequest()
        await state.requestAI({
            fragment,
            template,
            label,
        })
    }

    const resolveSpec = async (frag: Fragment | string | vscode.Uri) => {
        // "next logic"
        if (frag === undefined && state.aiRequest) {
            const previous = state.aiRequest.options.fragment
            frag = previous?.fullId
        }

        if (frag instanceof vscode.Uri) frag = frag.fsPath

        const { project } = state

        let fragment: Fragment
        if (typeof frag === "string" && !/\.gpspec\.md$/i.test(frag)) {
            const gpspecs = project.rootFiles.filter((f) =>
                f.roots.some((r) =>
                    r.references.some((ref) => ref.filename === frag)
                )
            )
            const pick = gpspecs.length
                ? await vscode.window.showQuickPick(
                      [
                          ...project.rootFiles
                              .filter((f) =>
                                  f.roots.some((r) =>
                                      r.references.some(
                                          (ref) => ref.filename === frag
                                      )
                                  )
                              )
                              .map((f) => ({
                                  label: Utils.basename(
                                      vscode.Uri.file(f.filename)
                                  ),
                                  file: f,
                              })),
                          {
                              label: "Create new GPSpec file...",
                              file: undefined,
                          },
                      ],
                      {
                          title: "Select GPSpec file",
                      }
                  )
                : { label: "", file: undefined }
            if (pick === undefined) return undefined
            if (pick.file) {
                fragment = pick.file.roots[0]
            } else {
                const document = vscode.window.visibleTextEditors.find(
                    (editor) => editor.document.uri.fsPath === frag
                )?.document
                if (document) {
                    const prj = await state.parseDocument(document)
                    fragment = prj?.rootFiles?.[0].fragments?.[0]
                }
            }
        } else {
            fragment = project.resolveFragment(frag)
        }

        return rootFragment(fragment)
    }

    const fragmentRefine = async () => {
        await state.cancelAiRequest()
        const fragment = await resolveSpec(undefined)
        if (!fragment) return

        const template = state.aiRequest.options.template
        let refinement = await vscode.window.showInputBox({
            title: `What do you want to add to your spec?`,
            prompt: `Your recommendation will be added at the end of the gpspec.md file; then the tool will be started again.`,
        })
        if (!refinement) return

        await saveAllTextDocuments()
        const uri = vscode.Uri.file(fragment.file.filename)
        let content = new TextDecoder().decode(
            await vscode.workspace.fs.readFile(uri)
        )

        // insert in top fragment
        const lines = content.split("\n")
        lines.splice(fragment.endPos[0], 0, `-   ${refinement}`)

        content = lines.join("\n")

        vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content))
        await saveAllTextDocuments()

        vscode.window.showInformationMessage(
            `GPTools - Added refinement in ${Utils.basename(
                vscode.Uri.file(fragment.file.filename)
            )}. Please wait for the tool to start again.`
        )

        await fragmentPrompt(fragment, template)
    }

    const fragmentPrompt = async (
        frag?: Fragment | string | vscode.Uri,
        template?: PromptTemplate
    ) => {
        if (!(await checkSaved())) return

        await state.cancelAiRequest()
        const fragment = await resolveSpec(frag)
        if (!fragment) {
            vscode.window.showErrorMessage(
                "GPTools - sorry, we could not find where to apply the tool. Please try to launch GPTools from the editor."
            )
            return
        }
        if (!template) {
            template = await pickTemplate(fragment)
            if (!template) return
        }
        await fragmentExecute(fragment, template.title, template.id)
    }
    const fragmentNavigate = async (fragment: Fragment | string) => {
        fragment = state.project.resolveFragment(fragment)
        if (!fragment) return
        const { file, startPos } = fragment
        const uri = vscode.Uri.file(file.filename)
        const editor = await vscode.window.showTextDocument(uri)
        const pos = new vscode.Position(...startPos)
        editor.selections = [new vscode.Selection(pos, pos)]
        var range = new vscode.Range(pos, pos)
        editor.revealRange(range)
    }
    subscriptions.push(
        vscode.commands.registerCommand(
            "coarch.fragment.refine",
            fragmentRefine
        ),
        vscode.commands.registerCommand(
            "coarch.fragment.prompt",
            fragmentPrompt
        ),
        vscode.commands.registerCommand(
            "coarch.fragment.navigate",
            fragmentNavigate
        )
    )
}

function templatesToQuickPickItems(
    templates: globalThis.PromptTemplate[]
): TemplateQuickPickItem[] {
    const cats = groupBy(templates, templateGroup)
    const items: vscode.QuickPickItem[] = []
    for (const cat in cats) {
        items.push(<vscode.QuickPickItem>{
            label: cat,
            kind: vscode.QuickPickItemKind.Separator,
        })
        items.push(
            ...cats[cat].map(
                (template) =>
                    <TemplateQuickPickItem>{
                        label: template.title,
                        description: `${template.id} ${
                            template.description || ""
                        }`,
                        template,
                    }
            )
        )
    }
    items.push(<vscode.QuickPickItem>{
        label: "",
        kind: vscode.QuickPickItemKind.Separator,
    })
    items.push(<TemplateQuickPickItem>{
        label: "Create a new GPTool script...",
        description: "Create a new gptool script in the current workspace.",
        action: "create",
    })
    items.push(<TemplateQuickPickItem>{
        label: "View GPTools Discussions...",
        description: "Open the Discussions tab in the GPTools GitHub.",
        action: "discussions",
    })
    return items
}

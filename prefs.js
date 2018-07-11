
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Gdk = imports.gi.Gdk;
const Lang = imports.lang;
const Mainloop = imports.mainloop;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Convenience = Me.imports.convenience;

const WORKSPACE_KEY = 'org.gnome.Shell.Extensions.PaperWM.Workspace';
const KEYBINDINGS_KEY = 'org.gnome.Shell.Extensions.PaperWM.Keybindings';
const WORKSPACE_LIST_KEY = 'org.gnome.Shell.Extensions.PaperWM.WorkspaceList';

const wmSettings = new Gio.Settings({ schema_id:
                                    'org.gnome.desktop.wm.preferences'});

let _ = s => s;

// TreeStore model
const COLUMN_ID          = 0;
const COLUMN_INDEX       = 1;
const COLUMN_DESCRIPTION = 2;
const COLUMN_KEY         = 3;
const COLUMN_MODS        = 4;

const schemaSource = Gio.SettingsSchemaSource.new_from_directory(
    GLib.build_filenamev([Me.path, "schemas"]),
    Gio.SettingsSchemaSource.get_default(),
    false
);

const workspaceList = new Gio.Settings({
    settings_schema: schemaSource.lookup(WORKSPACE_LIST_KEY, true)
});

function getWorkspaceSettingsByUUID(uuid) {
    return new Gio.Settings({
        settings_schema: schemaSource.lookup(WORKSPACE_KEY, true),
        path: `/org/gnome/shell/extensions/paperwm/workspaces/${uuid}/`});
}

function getWorkspaceSettings(index) {
    let list = workspaceList.get_strv('list');
    for (let uuid of list) {
        let settings = getWorkspaceSettingsByUUID(uuid);
        if (settings.get_int('index') === index) {
            return [uuid, settings];
        }
    }
    return getNewWorkspaceSettings(index);
}

function getNewWorkspaceSettings(index) {
    let uuid = GLib.uuid_string_random();
    let settings = getWorkspaceSettingsByUUID(uuid);
    let id = settings.connect('changed', () => {
        settings.disconnect(id);

        if (settings.get_int('index') === -1) {
            settings.set_int('index', index);
        }

        let list = workspaceList.get_strv('list');
        list.push(uuid);
        workspaceList.set_strv('list', list);

    });
    return [uuid, settings];
}

function ok(okValue) {
    if(okValue[0]) {
        return okValue[1]
    } else {
        return null
    }
}

class SettingsWidget {
    constructor() {
        this._settings = Convenience.getSettings();
        this._workspaceList = workspaceList;

        this.builder = new Gtk.Builder();
        this.builder.add_from_file(Me.path + '/Settings.ui');

        this.widget = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER });
        this._notebook = this.builder.get_object('paperwm_settings');
        this.widget.add(this._notebook);

        // General

        let windowGap = this.builder.get_object('window_gap_spin');
        let gap = this._settings.get_int('window-gap');

        windowGap.set_value(gap);
        windowGap.connect('value-changed', () => {
            this._settings.set_int('window-gap', windowGap.get_value());
        });

        let hMargin = this.builder.get_object('hmargin_spinner');
        hMargin.set_value(this._settings.get_int('horizontal-margin'));
        hMargin.connect('value-changed', () => {
            this._settings.set_int('horizontal-margin', hMargin.get_value());
        });

        let vMargin = this.builder.get_object('vmargin_spinner');
        vMargin.set_value(this._settings.get_int('vertical-margin'));
        vMargin.connect('value-changed', () => {
            this._settings.set_int('vertical-margin', vMargin.get_value());
        });

        // Workspaces
        const workspaceCombo = this.builder.get_object('worskpace_combo_text');
        const workspaceStack = this.builder.get_object('workspace_stack');

        const nWorkspaces = wmSettings.get_int('num-workspaces');
        this.workspaceNames = wmSettings.get_strv('workspace-names');

        for (let i=0; i < nWorkspaces; i++) {
            let [uuid, settings] = getWorkspaceSettings(i);
            let view = this.createWorkspacePage(settings, i);

            workspaceStack.add_named(view, i.toString());
            let name = this.getWorkspaceName(settings, i);
            workspaceCombo.append_text(name);
        }

        workspaceCombo.connect('changed', () => {
            if (this._updatingName)
                return;

            let active = workspaceCombo.get_active();
            log(`active ${active}`);
            let page = workspaceStack.get_child_by_name(active.toString());
            workspaceStack.set_visible_child(page);
        });

        workspaceCombo.set_active(0);


        // Keybindings

        let settings = Convenience.getSettings(KEYBINDINGS_KEY);
        let box = this.builder.get_object('keybindings');
        box.spacing = 12;

        let windowFrame = new Gtk.Frame({label: _('Windows'),
                                         label_xalign: 0.5});
        let windows = createKeybindingWidget(settings);
        box.add(windowFrame);
        windowFrame.add(windows);

        ['new-window', 'close-window', 'switch-next', 'switch-previous',
         'switch-left', 'switch-right', 'switch-up', 'switch-down',
         'switch-first', 'switch-last', 'live-alt-tab', 'live-alt-tab-backward',
         'move-left', 'move-right', 'move-up', 'move-down',
         'slurp-in', 'barf-out', 'center-horizontally',
         'paper-toggle-fullscreen', 'toggle-maximize-width', 'cycle-width']
            .forEach(k => {
            addKeybinding(windows.model, settings, k);
        });

        let workspaceFrame = new Gtk.Frame({label: _('Workspaces'),
                                            label_xalign: 0.5});
        let workspaces = createKeybindingWidget(settings);
        box.add(workspaceFrame);
        workspaceFrame.add(workspaces);

        ['previous-workspace', 'previous-workspace-backward',
         'move-previous-workspace', 'move-previous-workspace-backward' ]
            .forEach(k => {
                addKeybinding(workspaces.model, settings, k);
            });


        let scratchFrame = new Gtk.Frame({label: _('Scratch layer'),
                                          label_xalign: 0.5});
        let scratch = createKeybindingWidget(settings);
        box.add(scratchFrame);
        scratchFrame.add(scratch);

        ['toggle-scratch-layer', 'toggle-scratch']
            .forEach(k => {
                addKeybinding(scratch.model, settings, k);
            });
    }

    createWorkspacePage(settings, index) {

        let view = new Gtk.Frame();
        let list = new Gtk.ListBox();
        view.add(list);

        let nameEntry = new Gtk.Entry();
        let colorButton = new Gtk.ColorButton();
        let background = new Gtk.FileChooserButton();

        list.add(createRow('Name', nameEntry));
        list.add(createRow('Color', colorButton));
        list.add(createRow('Background', background));

        let rgba = new Gdk.RGBA();
        let color = settings.get_string('color');
        let palette = this._settings.get_strv('workspace-colors');
        if (color === '')
            color = palette[index % palette.length];

        rgba.parse(color);
        colorButton.set_rgba(rgba);

        let filename = settings.get_string('background');
        if (filename === '')
            background.unselect_all();
        else
            background.set_filename(filename);

        nameEntry.set_text(this.getWorkspaceName(settings, index));

        let workspace_combo = this.builder.get_object('worskpace_combo_text');

        nameEntry.connect('changed', () => {
            let active = workspace_combo.get_active();
            let name = nameEntry.get_text();

            this._updatingName = true;
            workspace_combo.remove(active);
            workspace_combo.insert_text(active, name);

            workspace_combo.set_active(active);
            this._updatingName = false;

            settings.set_string('name', name);
        });

        colorButton.connect('color-set', () => {
            let color = colorButton.get_rgba().to_string();
            settings.set_string('color', color);
            settings.set_string('background', '');
            background.unselect_all();
        });

        background.connect('file-set', () => {
            let filename = background.get_filename();
            settings.set_string('background', filename);
        });

        return view;
    }

    getWorkspaceName(settings, index) {
        let name = settings.get_string('name');
        if (name === '')
            name = this.workspaceNames[index];
        if (name === undefined)
            name = `Workspace ${index}`;
        return name;
    }

}

function createRow(text, widget, signal, handler) {
    let margin = 12;
    let row = new Gtk.ListBoxRow({selectable: false});
    let box = new Gtk.Box({
        margin_start: margin, margin_end: margin,
        orientation: Gtk.Orientation.HORIZONTAL
    });
    let label = new Gtk.Label({
        label: text, hexpand: true, xalign: 0
    });

    box.add(label);
    box.add(widget);

    row.add(box);

    return row;
}

function createKeybindingWidget(settings) {
    let model = new Gtk.TreeStore();

    model.set_column_types(
            [GObject.TYPE_STRING, // COLUMN_ID
             GObject.TYPE_INT,    // COLUMN_INDEX
             GObject.TYPE_STRING, // COLUMN_DESCRIPTION
             GObject.TYPE_INT,    // COLUMN_KEY
             GObject.TYPE_INT]);  // COLUMN_MODS

    let treeView = new Gtk.TreeView();
    treeView.model = model;
    treeView.headers_visible = false;
    treeView.margin_start = 12;
    treeView.margin_end = 12;
    treeView.search_column = COLUMN_DESCRIPTION;
    treeView.enable_search = true;

    let descriptionRenderer = new Gtk.CellRendererText();
    let descriptionColumn = new Gtk.TreeViewColumn();
    descriptionColumn.expand = true;
    descriptionColumn.pack_start(descriptionRenderer, true);
    descriptionColumn.add_attribute(descriptionRenderer, "text", COLUMN_DESCRIPTION);

    treeView.append_column(descriptionColumn);

    let accelRenderer = new Gtk.CellRendererAccel();
    accelRenderer.accel_mode = Gtk.CellRendererAccelMode.GTK;
    accelRenderer.editable = true;

    accelRenderer.connect("accel-edited",
            (accelRenderer, path, key, mods, hwCode) => {
                let iter = ok(model.get_iter_from_string(path));
                if(!iter)
                    return;

                // Update the UI.
                model.set(iter, [COLUMN_KEY, COLUMN_MODS], [key, mods]);

                // Update the stored setting.
                let id = model.get_value(iter, COLUMN_ID);
                let index = model.get_value(iter, COLUMN_INDEX);
                let accelString = Gtk.accelerator_name(key, mods);

                let accels = settings.get_strv(id);

                if (index === -1) {
                    accels.push(accelString);
                } else {
                    accels[index] = accelString
                }
                settings.set_strv(id, accels);

                let newEmptyRow = null, parent;
                if (index === -1) {
                    model.set_value(iter, COLUMN_INDEX, accels.length-1);
                    model.set_value(iter, COLUMN_DESCRIPTION, "...");

                    let parent = ok(model.iter_parent(iter));
                    newEmptyRow = model.insert_after(parent, iter);
                } else if (index === 0 && !model.iter_has_child(iter)) {
                    newEmptyRow = model.insert(iter, -1);
                }

                if (newEmptyRow) {
                    model.set(newEmptyRow, ...transpose([
                        [COLUMN_ID, id],
                        [COLUMN_INDEX, -1],
                        [COLUMN_DESCRIPTION, "New binding"],
                        [COLUMN_KEY, 0],
                        [COLUMN_MODS, 0],
                    ]));
                }

            });

    accelRenderer.connect("accel-cleared",
            (accelRenderer, path) => {
                let iter = ok(model.get_iter_from_string(path));
                if(!iter)
                    return;


                let index = model.get_value(iter, COLUMN_INDEX);

                // Update the UI.
                model.set(iter, [COLUMN_KEY, COLUMN_MODS], [0, 0]);

                if (index === -1) {
                    // Clearing the empty row
                    return;
                }

                let id = model.get_value(iter, COLUMN_ID);
                let accels = settings.get_strv(id);
                accels.splice(index, 1);

                let parent, nextSibling;
                // Simply rebuild the model for this action
                if (index === 0) {
                    parent = iter.copy();
                } else {
                    parent = ok(model.iter_parent(iter));
                }
                nextSibling = parent.copy();

                if(!model.iter_next(nextSibling))
                    nextSibling = null;

                model.remove(parent);

                // Update the stored setting.
                settings.set_strv(id, accels);

                let recreated = addKeybinding(model, settings, id, nextSibling);
                let selection = treeView.get_selection();
                selection.select_iter(recreated);
            });

    let accelColumn = new Gtk.TreeViewColumn();
    accelColumn.pack_end(accelRenderer, false);
    accelColumn.add_attribute(accelRenderer, "accel-key", COLUMN_KEY);
    accelColumn.add_attribute(accelRenderer, "accel-mods", COLUMN_MODS);

    treeView.append_column(accelColumn);

    return treeView;
}

function parseAccelerator(accelerator) {
    let key, mods;
    if (accelerator == null)
        [key, mods] = [0, 0];
    else
        [key, mods] = Gtk.accelerator_parse(accelerator);
    return [key, mods];
}

function transpose(colValPairs) {
    let colKeys = [], values = [];
    colValPairs.forEach(([k, v]) => {
        colKeys.push(k); values.push(v);
    })
    return [colKeys, values];
}

function addKeybinding(model, settings, id, position=null) {
    let accels = settings.get_strv(id);
    let accelerator = accels[0];

    let schema = settings.settings_schema;
    let schemaKey = schema.get_key(id);
    let description = _(schemaKey.get_summary());

    // Add a row for the keybinding.
    let [key, mods] = parseAccelerator(accelerator);
    let row = model.insert_before(null, position);
    model.set(row, ...transpose([
        [COLUMN_ID, id],
        [COLUMN_INDEX, 0],
        [COLUMN_DESCRIPTION, description],
        [COLUMN_KEY, key],
        [COLUMN_MODS, mods],
    ]));

    // Add one subrow for each additional keybinding
    accels.slice(1).forEach((accelerator, i) => {
        let [key, mods] = parseAccelerator(accelerator);
        let subrow = model.insert(row, 0);
        model.set(subrow, ...transpose([
            [COLUMN_ID, id],
            [COLUMN_INDEX, i+1],
            [COLUMN_DESCRIPTION, "..."],
            [COLUMN_KEY, key],
            [COLUMN_MODS, mods],
        ]));
    });

    if (accels.length !== 0) {
        // Add an empty row used for adding new bindings
        let emptyRow = model.append(row);
        model.set(emptyRow, ...transpose([
            [COLUMN_ID, id],
            [COLUMN_INDEX, -1],
            [COLUMN_DESCRIPTION, "New binding"],
            [COLUMN_KEY, 0],
            [COLUMN_MODS, 0],
        ]));
    }

    return row;
}

function init() {
}

function buildPrefsWidget() {
    let settings = new SettingsWidget();
    let widget = settings.widget;
    widget.show_all();
    return widget;
}